// Test-only D1 accounting; no SQL text, params, user records or credentials are logged.
export function countedDB(db,stats){
 const collect=r=>{stats.queries++;stats.read+=(r.meta?.rows_read??0);stats.written+=(r.meta?.rows_written??0);return r;};
 const wrap=stmt=>({
  _stmt:stmt,
  bind(...args){return wrap(stmt.bind(...args));},
  async all(){return collect(await stmt.all());},
  async run(){return collect(await stmt.run());},
  async first(column){const r=collect(await stmt.all());const row=r.results[0]??null;return column?row?.[column]??null:row;}
 });
 return {prepare(q){return wrap(db.prepare(q));},async batch(stmts){const rs=await db.batch(stmts.map(s=>s._stmt));return rs.map(collect);}};
}
