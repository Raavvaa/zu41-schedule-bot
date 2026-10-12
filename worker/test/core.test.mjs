import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validTime,dayKey,at,addDays,monday,visible,formatDay,nextLesson,pack} from '../src/core.mjs';
const data={status:'confirmed',date:'2026-10-12',lessons:[{number:1,start:'09:00',end:'10:30',variants:[{subject:'Общая',subgroup:'',teacher:'Учитель',room:'305'},{subject:'А',subgroup:'1'},{subject:'Б',subgroup:'2'}]},{number:2,start:'10:40',end:'12:10',variants:[{subject:'Право',subgroup:''}]}]};
const u={group_id:63,group_name:'ЗУ-41/23',subgroup:'1'};
test('Moscow dates and 06:00/custom times, boundaries across year',()=>{
 assert.equal(at('2026-10-12','06:00'),Date.parse('2026-10-12T03:00:00Z'));
 assert.equal(at('2026-10-12','07:35'),Date.parse('2026-10-12T04:35:00Z'));
 assert.equal(dayKey(Date.parse('2026-12-31T21:00:00Z')),'2027-01-01');
 assert.equal(addDays('2026-12-31',1),'2027-01-01');assert.equal(monday('2027-01-03'),'2026-12-28');
 for(const x of ['06:00','00:00','23:59'])assert.ok(validTime(x));
 for(const x of ['24:00','12:60','6:00','-1:20','abc'])assert.ok(!validTime(x));
});
test('subgroup filtering always includes shared lessons',()=>{
 const ls=visible(data,'1');assert.equal(ls.length,2);assert.deepEqual(ls[0].variants.map(v=>v.subject),['Общая','А']);
 assert.equal(visible(data,'both')[0].variants.length,3);
});
test('current class and next class, never misleading remaining 10 minutes',()=>{
 assert.match(nextLesson(data,u,at(data.date,'09:10')),/Сейчас идёт/);
 assert.match(nextLesson(data,u,at(data.date,'08:50')),/Следующая пара/);
 assert.match(nextLesson(data,u,at(data.date,'12:11')),/следующих пар/);
});
test('missing data is different from explicit no classes and selected subgroup empty',()=>{
 for(const status of ['network_error','invalid','unpublished']){
  const text=formatDay({...data,status},u);assert.match(text,/не означает выходной/);assert.doesNotMatch(text,/занятий нет/);
 }
 assert.match(formatDay({...data,lessons:[],explicitEmpty:true},u),/На сайте указано/);
 assert.match(formatDay({...data,lessons:[],explicitEmpty:false},u),/подгруппы занятия не указаны/);
});
test('long HTML-safe messages preserve fields without broken entities or tags',()=>{
 const raw=('A <script> & '+ 'В'.repeat(800)+'\n').repeat(20);const parts=pack(raw);
 assert.ok(parts.length>1);for(const p of parts){assert.ok(p.text.length<4096);assert.ok(!p.text.includes('<script>'));assert.ok(!p.text.endsWith('&am'));}
 const decoded=parts.map(p=>p.text.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')).join('\n');assert.ok(decoded.includes('<script> & '));
});
