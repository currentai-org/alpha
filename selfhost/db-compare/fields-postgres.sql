-- Alpha's Postgres: every table.column holding either canary, with how many rows hold each. run.sh
-- pipes it into psql with -v user=... -v answer=...; \gexec runs one counting query per text-like
-- column. Prints one tab-separated line per hit: table.column, rows with the user canary, with the
-- answer canary.
\pset format unaligned
\pset fieldsep '\t'
\pset tuples_only on
select format(
	'select %L || ''.'' || %L, u, a from (select count(*) filter (where %I::text like %L) u, count(*) filter (where %I::text like %L) a from %I.%I) c where u + a > 0',
	table_name, column_name,
	column_name, '%' || :'user' || '%',
	column_name, '%' || :'answer' || '%',
	table_schema, table_name)
from information_schema.columns
where table_schema not in ('pg_catalog', 'information_schema')
	and data_type in ('text', 'character varying', 'json', 'jsonb', 'bytea', 'ARRAY', 'USER-DEFINED')
order by table_schema, table_name, ordinal_position
\gexec
