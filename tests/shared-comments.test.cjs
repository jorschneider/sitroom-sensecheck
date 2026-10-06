const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../judges/comments/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nloadComments\(\);\s*$/, '');
const fixture = () => [
  {round:'config', order:'[6,8,35]'},
  {round:'final', judge:'Kevin', mode:'rank', order:'[8,6,35]', fin_note:JSON.stringify({6:'Kevin final comment',8:'<img src=x onerror=alert(1)>'})},
  {round:'final', judge:'John', mode:'tiers', tiers:{6:'A'}, fin_note:{6:'John unfinished ballot comment'}},
  {round:'r1', judge:'Florian', sub:6, cat:1, works:'Florian strengths', improve:'Florian improvements', next:'Florian next steps', note:'Board note <script>alert(1)</script>'},
  {round:'r1', judge:'Neeraj', sub:8, cat:2, works:'Neeraj strengths'}
];
function portal(rows=fixture()) {
  const elements = new Map();
  const buttons = ['final','r1','all'].map(round=>({dataset:{round},setAttribute(k,v){this[k]=v}}));
  const calls = [];
  let response = {ok:true,json:async()=>({rows})};
  const document = {visibilityState:'visible',querySelectorAll:()=>buttons,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',disabled:false,className:''});return elements.get(id)}};
  const context = vm.createContext({document,Date,setInterval(){},fetch:async(url,options)=>{calls.push({url,options});if(response instanceof Error)throw response;return response}});
  vm.runInContext(script+'\n;globalThis.app={state,render,loadComments,viewData,parse};',context);
  return {app:context.app,calls,board:document.getElementById('board'),counts:document.getElementById('counts'),sync:document.getElementById('sync'),response(value){response=value}};
}
test('all final judges are visible, including incomplete feedback, and comments are escaped',async()=>{
 const p=portal();await p.app.loadComments();
 assert.match(p.board.innerHTML,/Kevin final comment/);
 assert.match(p.board.innerHTML,/John unfinished ballot comment/);
 for(const judge of ['Florian','Kevin','Neeraj','John'])assert.ok(p.board.innerHTML.includes(`<h4>${judge}</h4>`));
 assert.match(p.board.innerHTML,/No written final-round feedback yet/);
 assert.match(p.board.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(p.board.innerHTML,/<img src=x/);
 assert.equal(p.counts.textContent,'3 projects · 3 written reviews');
 assert.ok(p.board.innerHTML.indexOf('<h4>Kevin</h4>')<p.board.innerHTML.indexOf('<h4>Florian</h4>'));
});
test('Round 1 and all-round views expose other judges’ feedback and board notes',async()=>{
 const p=portal();await p.app.loadComments();p.app.state.round='r1';p.app.render();
 for(const text of ['Florian strengths','Florian improvements','Florian next steps','Neeraj strengths','Note to the judging board'])assert.ok(p.board.innerHTML.includes(text));
 assert.match(p.board.innerHTML,/Board note &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
 assert.doesNotMatch(p.board.innerHTML,/Kevin final comment/);
 p.app.state.round='all';p.app.render();
 assert.match(p.board.innerHTML,/Kevin final comment/);assert.match(p.board.innerHTML,/Florian strengths/);
 assert.equal(p.counts.textContent,'3 projects · 5 written reviews');
});
test('judge, project, and comment search filters work together',async()=>{
 const p=portal();await p.app.loadComments();p.app.state.judge='John';p.app.state.search='unfinished';p.app.render();
 assert.match(p.board.innerHTML,/John unfinished ballot comment/);assert.doesNotMatch(p.board.innerHTML,/Kevin final comment/);
 assert.equal(p.counts.textContent,'1 project · 1 written review');
 p.app.state.search='';p.app.state.project='8';p.app.render();assert.match(p.board.innerHTML,/Foxhole Forecast/);assert.doesNotMatch(p.board.innerHTML,/StratEval/);
 p.app.state.project='35';p.app.state.search='no match';p.app.render();assert.match(p.board.innerHTML,/No projects match these filters/);
});
test('refresh shows new comments, preserves the last good data on failure, and only reads',async()=>{
 const p=portal();await p.app.loadComments();const changed=fixture();changed[1].fin_note={6:'New final feedback'};
 p.response({ok:true,json:async()=>({rows:changed})});await p.app.loadComments();assert.match(p.board.innerHTML,/New final feedback/);assert.doesNotMatch(p.board.innerHTML,/Kevin final comment/);
 const before=p.board.innerHTML;p.response(new Error('offline'));await p.app.loadComments();assert.equal(p.board.innerHTML,before);assert.match(p.sync.textContent,/last loaded comments/);
 p.response({ok:true,json:async()=>({rows:null})});await p.app.loadComments();assert.equal(p.board.innerHTML,before);
 assert.ok(p.calls.every(c=>c.url==='https://sitroom-api.vercel.app/api/load'&&!c.options.method&&!c.options.body));
 assert.deepEqual(JSON.parse(JSON.stringify(p.app.parse('{}',[]))),[]);
});
