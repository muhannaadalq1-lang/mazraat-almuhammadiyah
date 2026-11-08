-- مزرعة المحمدية — قاعدة البيانات
-- يُشغَّل مرة واحدة من Supabase: SQL Editor ← New query ← الصق ← Run

-- 1) جدول واحد لكل بيانات الموقع، مقسّم حسب "collection"
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- 2) المشرفون: owner = المالك (يشوف المالية)، editor = موظف (بدون المالية)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role    text not null check (role in ('owner','editor'))
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins where user_id = auth.uid());
$$;
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins where user_id = auth.uid() and role = 'owner');
$$;
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.admins where user_id = auth.uid();
$$;

alter table public.docs   enable row level security;
alter table public.admins enable row level security;

drop policy if exists "admins read own" on public.admins;
create policy "admins read own" on public.admins for select using (user_id = auth.uid() or public.is_owner());

-- 3) صلاحيات القراءة
drop policy if exists "public read" on public.docs;
create policy "public read" on public.docs for select using (
  collection in ('settings','calendar','reviews','coupons','media','holds')
);
drop policy if exists "admin read" on public.docs;
create policy "admin read" on public.docs for select using (
  public.is_admin() and collection in ('requests','waitlist','reviewSubs','customers','ops','maint')
);
drop policy if exists "owner read" on public.docs;
create policy "owner read" on public.docs for select using (
  public.is_owner() and collection in ('finance','workers')
);
drop policy if exists "self read" on public.docs;
create policy "self read" on public.docs for select using (
  auth.uid() is not null and id = auth.uid()::text and collection in ('requests','waitlist','reviewSubs')
);

-- 4) صلاحيات الكتابة
drop policy if exists "admin write" on public.docs;
create policy "admin write" on public.docs for all
  using (public.is_admin() and collection not in ('finance','workers'))
  with check (public.is_admin() and collection not in ('finance','workers'));
drop policy if exists "owner write" on public.docs;
create policy "owner write" on public.docs for all
  using (public.is_owner()) with check (public.is_owner());
drop policy if exists "self insert" on public.docs;
create policy "self insert" on public.docs for insert with check (
  auth.uid() is not null and id = auth.uid()::text and collection in ('requests','holds','waitlist','reviewSubs')
);
drop policy if exists "self update" on public.docs;
create policy "self update" on public.docs for update
  using (auth.uid() is not null and id = auth.uid()::text and collection in ('requests','holds','waitlist','reviewSubs'))
  with check (auth.uid() is not null and id = auth.uid()::text and collection in ('requests','holds','waitlist','reviewSubs'));

-- 5) تحديث تلقائي للوقت + البث المباشر للتغييرات
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.touch_updated_at();

do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 6) تخزين الصور والفيديو المرفوعة من لوحة التحكم
insert into storage.buckets (id, name, public) values ('media','media', true)
on conflict (id) do nothing;
drop policy if exists "media public read" on storage.objects;
create policy "media public read" on storage.objects for select using (bucket_id = 'media');
drop policy if exists "media admin write" on storage.objects;
create policy "media admin write" on storage.objects for insert with check (bucket_id = 'media' and public.is_admin());
drop policy if exists "media admin delete" on storage.objects;
create policy "media admin delete" on storage.objects for delete using (bucket_id = 'media' and public.is_admin());
