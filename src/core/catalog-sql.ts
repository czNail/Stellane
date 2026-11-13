// One statement observes pg_catalog under a single PostgreSQL statement snapshot.
// Selectable objects only; the 65th object makes the explicit 64-object cap fail closed.
export const catalogSql = `WITH visible AS (
  SELECT c.oid,c.relname,c.relkind,c.relrowsecurity,c.relhassubclass,n.nspname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema','stellane_internal')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
    AND pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_table_privilege(c.oid,'SELECT')
  ORDER BY n.nspname,c.relname LIMIT 65
), lineage AS (
  SELECT dst.nspname AS dst_schema,dst.relname AS dst_name,src.nspname AS src_schema,src.relname AS src_name,
    COALESCE(jsonb_agg(DISTINCT a.attname ORDER BY a.attname) FILTER (WHERE a.attname IS NOT NULL),'[]'::jsonb) AS columns
  FROM visible dst
  JOIN pg_catalog.pg_rewrite r ON r.ev_class=dst.oid AND r.rulename='_RETURN'
  JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_rewrite'::regclass AND d.objid=r.oid
    AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype='n' AND d.refobjid<>dst.oid
  JOIN visible src ON src.oid=d.refobjid
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=src.oid AND a.attnum=d.refobjsubid AND a.attnum>0 AND NOT a.attisdropped
  WHERE dst.relkind IN ('v','m')
  GROUP BY dst.nspname,dst.relname,src.nspname,src.relname
  ORDER BY dst.nspname,dst.relname,src.nspname,src.relname LIMIT 257
)
SELECT jsonb_build_object('databaseOid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()),
  'snapshot',pg_catalog.pg_current_snapshot()::text,
  'profileTables',COALESCE((SELECT jsonb_agg(oid::text ORDER BY oid) FROM visible
    WHERE relkind='r' AND NOT relrowsecurity AND NOT relhassubclass),'[]'::jsonb),
  'lineage',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'upstream',jsonb_build_object('schema',src_schema,'table',src_name,'columns',columns),
    'downstream',jsonb_build_object('schema',dst_schema,'table',dst_name)) ORDER BY dst_schema,dst_name,src_schema,src_name) FROM lineage),'[]'::jsonb),
  'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
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
