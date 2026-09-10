const OWNER = 'jorschneider', REPO = 'sitroom-responses';
const H = t => ({ Authorization: `Bearer ${t}`, 'User-Agent': 'sitroom-api', Accept: 'application/vnd.github+json' });
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS'); res.setHeader('Cache-Control', 'no-store'); }
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const t = process.env.GITHUB_TOKEN;
  const list = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/data?t=${Date.now()}`, { headers: H(t) });
  if (list.status === 404) return res.status(200).json({ ok: true, rows: [] });
  if (!list.ok) return res.status(500).json({ ok: false, status: list.status });
  const files = (await list.json()).filter(f => f.name.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    const g = await fetch(f.url, { headers: H(t) }); if (!g.ok) continue;
    const j = await g.json(); let cur = {};
    try { cur = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch (e) {}
    Object.values(cur).forEach(r => rows.push(r));
  }
  return res.status(200).json({ ok: true, rows });
};
