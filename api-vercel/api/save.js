const OWNER = 'jorschneider', REPO = 'sitroom-responses';
const H = t => ({ Authorization: `Bearer ${t}`, 'User-Agent': 'sitroom-api', Accept: 'application/vnd.github+json' });
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const t = process.env.GITHUB_TOKEN;
  let d = req.body; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return res.status(400).json({ ok: false, error: 'bad json' }); } }
  if (!d || !d.judge || !d.round) return res.status(400).json({ ok: false, error: 'judge and round required' });
  const file = `data/${String(d.judge).replace(/[^A-Za-z0-9]/g, '_')}.json`;
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${file}`;
  const key = `${d.round}|${d.sub || 0}`;
  for (let i = 0; i < 4; i++) {
    let sha, cur = {};
    const g = await fetch(url, { headers: H(t) });
    if (g.ok) { const j = await g.json(); sha = j.sha; try { cur = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch (e) { cur = {}; } }
    cur[key] = { ...d, timestamp: new Date().toISOString() };
    const p = await fetch(url, { method: 'PUT', headers: { ...H(t), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `save ${d.judge} ${key}`, content: Buffer.from(JSON.stringify(cur, null, 1)).toString('base64'), sha }) });
    if (p.ok) return res.status(200).json({ ok: true });
    if (p.status !== 409 && p.status !== 422) { const txt = await p.text(); return res.status(500).json({ ok: false, status: p.status, body: txt.slice(0, 200) }); }
    await new Promise(r => setTimeout(r, 200 * (i + 1)));
  }
  return res.status(500).json({ ok: false, error: 'write conflict' });
};
