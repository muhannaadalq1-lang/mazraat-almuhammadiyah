/* Supabase backend for the farm site.
   Exposes window.claude.use(name) with the same small API the page was written against:
   db (doc/collection with get/set/update/delete/onSnapshot), user, assets, downloads. */
(function(){
  const SUPABASE_URL = "https://vnrujdpzmvenkauexppx.supabase.co";
  const SUPABASE_KEY = "sb_publishable_7wQLtrvohnaveuIU7Y-CKg_wFArC4aX"; // publishable key: safe in the browser, access is enforced by row-level security
  // Cloudflare Turnstile site key (public). Leave empty to run without the bot check.
  const TURNSTILE_SITE_KEY = "0x4AAAAAAF6H2ktIAJSFsugu";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  window.sb = sb;

  /* ---------- bot check (Cloudflare Turnstile, invisible) ---------- */
  let tsLoad = null;
  function loadTurnstile(){
    if(!tsLoad) tsLoad = new Promise((res, rej)=>{
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true;
      s.onload = ()=> res(window.turnstile); s.onerror = rej; document.head.appendChild(s);
    });
    return tsLoad;
  }
  // Never blocks on its own: if the check can't run, it returns no token and Supabase decides.
  async function captchaToken(){
    if(!TURNSTILE_SITE_KEY) return undefined;
    try{ return await Promise.race([getToken(), new Promise(r=>setTimeout(()=>r(undefined), 15000))]); }
    catch(e){ console.warn("Turnstile:", e); return undefined; }
  }
  async function getToken(){
    const ts = await loadTurnstile();
    return new Promise((res, rej)=>{
      const box = document.createElement("div"); box.style.cssText = "position:fixed;bottom:12px;left:12px;z-index:70";
      document.body.appendChild(box);
      const done = (fn, v)=>{ try{ ts.remove(id); }catch{} box.remove(); fn(v); };
      const id = ts.render(box, { sitekey: TURNSTILE_SITE_KEY, appearance: "interaction-only",
        callback: t => done(res, t), "error-callback": ()=> done(rej, new Error("captcha")), "timeout-callback": ()=> done(rej, new Error("captcha")) });
    });
  }

  /* ---------- session & roles ---------- */
  let roleP = null;
  async function session(){ const { data } = await sb.auth.getSession(); return data.session; }
  async function role(){
    if(!roleP) roleP = (async ()=>{ const s = await session(); if(!s || s.user.is_anonymous) return null;
      const { data, error } = await sb.rpc("my_role"); return error ? null : data; })();
    return roleP;
  }
  async function ensureUser(){
    let s = await session();
    if(!s){ const { data, error } = await sb.auth.signInAnonymously({ options: { captchaToken: await captchaToken() } }); if(error) throw error; s = data.session; }
    return s.user.id;
  }

  /* ---------- live refresh: realtime per collection + a slow poll as a safety net ---------- */
  const listeners = {};           // collection -> Set(refresh fn)
  const channels = {};
  function listen(col, fn){
    (listeners[col] ||= new Set()).add(fn);
    if(!channels[col]){
      channels[col] = sb.channel("docs-"+col)
        .on("postgres_changes", { event:"*", schema:"public", table:"docs", filter:"collection=eq."+col }, ()=> bump(col))
        .subscribe();
    }
    return ()=> listeners[col].delete(fn);
  }
  const timers = {};
  function bump(col){ clearTimeout(timers[col]); timers[col] = setTimeout(()=> (listeners[col]||[]).forEach(f=>f()), 120); }
  setInterval(()=>{ if(document.hidden) return; Object.keys(listeners).forEach(bump); }, 45000);
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) Object.keys(listeners).forEach(bump); });

  const meta = { fromCache:false, hasPendingWrites:false };
  const snap = (id, data) => ({ id, exists: data !== undefined, data: ()=> data, metadata: meta });
  function split(path){ const p = path.split("/"); return [p[0], p.slice(1).join("/")]; }
  const err = e => Object.assign(new Error(e?.message || "db error"), { code: "unavailable", cause: e });

  function doc(path){
    const [col, id] = split(path);
    const api = {
      id, path,
      async get(){ const { data, error } = await sb.from("docs").select("data").eq("collection", col).eq("id", id).maybeSingle();
        if(error) throw err(error); return snap(id, data ? data.data : undefined); },
      async set(body){ if(col==="requests"||col==="holds"||col==="waitlist"||col==="reviewSubs") await ensureUser();
        const { error } = await sb.from("docs").upsert({ collection: col, id, data: body }); if(error) throw err(error); bump(col); },
      async update(patch){ const cur = await api.get(); if(!cur.exists) throw Object.assign(new Error("missing"), { code:"invalid_argument" });
        await api.set({ ...cur.data(), ...patch }); },
      async delete(){ const { error } = await sb.from("docs").delete().eq("collection", col).eq("id", id); if(error) throw err(error); bump(col); },
      onSnapshot(next, onErr){
        let dead = false;
        const run = async ()=>{ if(dead) return; try{ next(await api.get()); }catch(e){ onErr && onErr(e); } };
        const off = listen(col, run); run();
        return ()=>{ dead = true; off(); };
      }
    };
    return api;
  }
  function collection(col){
    const api = {
      doc: id => doc(col+"/"+id),
      async get(){ const { data, error } = await sb.from("docs").select("id,data").eq("collection", col).limit(5000);
        if(error) throw err(error); const docs = data.map(r=>snap(r.id, r.data)); return { docs, size: docs.length, empty: !docs.length, metadata: meta }; },
      onSnapshot(next, onErr){
        let dead = false;
        const run = async ()=>{ if(dead) return; try{ next(await api.get()); }catch(e){ onErr && onErr(e); } };
        const off = listen(col, run); run();
        return ()=>{ dead = true; off(); };
      }
    };
    return api;
  }

  const caps = {
    db: { doc, collection },
    user: {
      async id(){ const s = await session(); return s ? s.user.id : null; },
      ensure: ensureUser,
      async canEdit(){ return !!(await role()); },
      async isOwner(){ return (await role()) === "owner"; },
      async email(){ const s = await session(); return s && !s.user.is_anonymous ? s.user.email : null; },
      async signIn(email, password){ const { error } = await sb.auth.signInWithPassword({ email, password, options: { captchaToken: await captchaToken() } }); if(error) throw error; roleP = null; },
      async signOut(){ await sb.auth.signOut(); roleP = null; },
      async setPassword(password){ const { error } = await sb.auth.updateUser({ password }); if(error) throw error; }
    },
    assets: {
      async upload(file){
        const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g,"");
        const path = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8) + "." + ext;
        const { error } = await sb.storage.from("media").upload(path, file, { contentType: file.type, upsert: false });
        if(error) throw error;
        return { id: path, url: sb.storage.from("media").getPublicUrl(path).data.publicUrl, sizeBytes: file.size, contentType: file.type };
      },
      async delete(id){ if(!id || id.length===32) return; await sb.storage.from("media").remove([id]); }
    },
    downloads: {
      async save({ filename, data }){
        const blob = data instanceof Blob ? data : new Blob([data]);
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
        document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        return "saved";
      }
    }
  };
  window.claude = { use: async name => caps[name] || null };
})();
