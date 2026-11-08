-- خيار المبيت + وقت الخروج الجديد (٣ الفجر) — يُشغَّل مرة واحدة
update public.docs set data =
  jsonb_set(jsonb_set(jsonb_set(jsonb_set(data,
    '{packages,0,out}', '"٣:٠٠ فجرًا"'),
    '{packages,1,out}', '"٣:٠٠ فجرًا"'),
    '{packages,2,out}', '"٣:٠٠ فجرًا"'),
    '{faq,2,a}', '"الدخول الساعة ١٢:٠٠ ظهرًا، والخروج الساعة ٣:٠٠ فجرًا. ويوجد خيار مبيت حتى الساعة ١٠:٠٠ صباحًا بإضافة ٢٠٠ ريال للقسم الواحد أو ٣٠٠ ريال للقسمين."')
  || '{"checkOut":"٣:٠٠ فجرًا","overnight":{"s1":200,"s2":200,"both":300,"out":"١٠:٠٠ صباحًا"}}'::jsonb
where collection = 'settings' and id = 'main';
