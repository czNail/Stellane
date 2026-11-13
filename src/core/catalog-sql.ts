// One statement observes pg_catalog under a single PostgreSQL statement snapshot.
// Selectable objects only; the 65th object makes the explicit 64-object cap fail closed.
export const catalogSql = `WITH visible AS (
  SELECT c.oid,c.relname,c.relkind,n.nspname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema','stellane_internal')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
    AND pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_table_privilege(c.oid,'SELECT')
  ORDER BY n.nspname,c.relname LIMIT 65
)
SELECT jsonb_build_object('databaseOid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()),
  'snapshot',pg_catalog.pg_current_snapshot()::text,'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'oid',c.oid::text,'schema',c.nspname,'name',c.relname,'kind',c.relkind::text,'comment',pg_catalog.obj_description(c.oid,'pg_class'),
    'view',CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,true) ELSE NULL END,
    'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('ordinal',a.attnum,'name',a.attname,
      'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'typeOid',a.atttypid::text,'nullable',NOT a.attnotnull,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity::text,'generated',a.attgenerated::text,'collationOid',a.attcollation::text,'comment',pg_catalog.col_description(c.oid,a.attnum)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
    'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype::text,
      'definition',pg_catalog.pg_get_constraintdef(k.oid,true),'validated',k.convalidated,
      'columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY u.pos) FROM unnest(k.conkey) WITH ORDINALITY u(num,pos)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.num),'[]'::jsonb),
      'references',CASE WHEN k.contype='f' THEN jsonb_build_object('oid',k.confrelid::text,'schema',rn.nspname,'table',rc.relname,
        'columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY u.pos) FROM unnest(k.confkey) WITH ORDINALITY u(num,pos)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.num),'[]'::jsonb)) ELSE NULL END) ORDER BY k.conname)
      FROM pg_catalog.pg_constraint k LEFT JOIN pg_catalog.pg_class rc ON rc.oid=k.confrelid
      LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace WHERE k.conrelid=c.oid),'[]'::jsonb)
  ) ORDER BY c.nspname,c.relname) FROM visible c),'[]'::jsonb)) AS metadata`;
