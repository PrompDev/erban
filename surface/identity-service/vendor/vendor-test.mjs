import pty from 'file:///C:/Erban/surface/identity-service/vendor/node-pty/lib/index.js'
const p = pty.spawn('cmd.exe', ['/c','echo','hello-from-pty'], { name:'xterm-color', cols:80, rows:24, cwd: process.cwd(), env: process.env })
let out=''
p.onData(d=>{out+=d})
setTimeout(()=>{ console.log('SPAWN_OK len='+out.length+' has_hello='+/hello-from-pty/.test(out)); process.exit(0) }, 2000)
