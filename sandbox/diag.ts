import { readFileSync } from 'node:fs'
import { Sandbox } from 'e2b'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url),'utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()]}))
process.env.E2B_API_KEY = env.E2B_API_KEY
const sbx = await Sandbox.create('cq-generation', { timeoutMs: 180_000 })
const run = async (cmd: string) => {
  const r = await sbx.commands.run(cmd, { timeoutMs: 90_000 }).catch((e: any) => ({ stdout:'', stderr: e?.result?.stderr ?? String(e), exitCode: 1 }))
  console.log(`$ ${cmd}\n${(r.stdout || r.stderr).trim().slice(0, 700)}\n`)
}
await run('whoami; echo HOME=$HOME')
await run('env | sort | grep -E "^(CQ_|PLAYWRIGHT|NODE_ENV)" || echo "(no CQ_/PLAYWRIGHT vars in command env)"')
await run('cat /etc/environment 2>/dev/null | head -5 || echo none')
await run('ls /ms-playwright 2>&1 | head -5')
await run('node -e "const{chromium}=require(\'/home/user/node_modules/playwright\');chromium.launch().then(async b=>{console.log(await b.version());await b.close()}).catch(e=>console.log(\'ERR\', e.message.slice(0,400)))"')
await sbx.kill()
