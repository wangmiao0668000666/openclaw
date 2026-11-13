import os,sys,json,time,signal,subprocess,pty,select,errno,threading,fcntl,termios,struct,re
from pathlib import Path
def re_sub(text):
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text)
# usage: drive.py <checkout> <outdir> <node> <expectation> <entry>
# entry: "src" -> node --import tsx src/entry.ts
checkout=Path(sys.argv[1]).resolve(); out=Path(sys.argv[2]).resolve(); node=Path(sys.argv[3]).resolve(); expect=sys.argv[4]; entry=sys.argv[5]
assert expect in ('red','green')
out.mkdir(parents=True,exist_ok=True)
for name in ['home','state','workspace','tmp']:(out/name).mkdir(exist_ok=True)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip()
receipt={'head':head,'expectation':expect,'cases':[],'result':'RUNNING'}
def save():(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
# isolated env
config=out/'config.json'
cfg={'gateway':{'mode':'local','bind':'loopback','controlUi':{'enabled':False},'auth':{'mode':'token','token':'synthetic-proof-token'}},'agents':{'defaults':{'workspace':str(out/'workspace')},'entries':{'main':{'workspace':str(out/'workspace')}}},'cron':{'enabled':False},'models':{'providers':{'ollama':{'baseUrl':'http://127.0.0.1:9','api':'ollama','models':[{'id':'synthetic-read-model','name':'Synthetic read model','contextWindow':8192,'maxTokens':2048}]}}}}
config.write_text(json.dumps(cfg));config.chmod(0o600)
env={'PATH':str(node.parent)+':/usr/bin:/bin','HOME':str(out/'home'),'USERPROFILE':str(out/'home'),'OPENCLAW_STATE_DIR':str(out/'state'),'OPENCLAW_CONFIG_PATH':str(config),'TMPDIR':str(out/'tmp'),'NO_COLOR':'1','TERM':'xterm-256color','OPENCLAW_DISABLE_BUNDLED_PLUGINS':'1','OPENCLAW_SKIP_CHANNELS':'1','OPENCLAW_SKIP_PROVIDERS':'1','OPENCLAW_SKIP_GMAIL_WATCHER':'1','OPENCLAW_SKIP_CRON':'1','OPENCLAW_SKIP_BROWSER_CONTROL_SERVER':'1','OPENCLAW_SKIP_CANVAS_HOST':'1'}
# start synthetic peer
peer=subprocess.Popen([str(node),'/tmp/backup-proof-harness/drive-peer.mjs',str(checkout)],cwd=checkout,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(out/'peer.stderr','wb'),text=True,bufsize=1,start_new_session=True)
first=json.loads(peer.stdout.readline());assert first['event']=='listening',first
port=first['port'];receipt['peerPort']=port;receipt['peerPid']=peer.pid
events=[]
def record():
    for line in peer.stdout:
        try:events.append(json.loads(line))
        except Exception:pass
thread=threading.Thread(target=record);thread.start()
# build CLI command: backup disable --port <peer port> (implicit local Gateway target via port override)
command=[str(node),'--import',str(checkout/'scripts/tsx.mjs'),str(checkout/'src/entry.ts'),'backup','disable','--port',str(port)]
cli_env={**env,'OPENCLAW_GATEWAY_URL':'','OPENCLAW_GATEWAY_TOKEN':'synthetic-proof-token'}
case=out/'sigint-case';case.mkdir(exist_ok=True)
started=time.monotonic();pid,master=pty.fork()
if pid==0:
    fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
    fd=os.open(case/'stderr.log',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);os.dup2(fd,2);os.close(fd)
    os.chdir(checkout);os.execve(str(node),command,cli_env)
data=bytearray();sent=None;status=None;eof=False;watchdog=False;exited=None;released=None
try:
    while time.monotonic()-started<40:
        held=any(e['event']=='remove-held' for e in events)
        if sent is None and held:
            sent=time.monotonic();stdout_at_interrupt=len(data)
            os.write(master,b'\x03')  # Ctrl+C = SIGINT
        # After SIGINT, give the CLI's AsyncWorkScope close a beat (the removal
        # loop breaks before starting offsite-job), then release the admitted
        # git-job removal so its receipt settles while later removals stay
        # unstarted. The admitted reply must settle to prove the receipt is kept.
        if sent is not None and released is None and time.monotonic()-sent>0.8:
            released=time.monotonic()
            peer.stdin.write('{"op":"release"}\n');peer.stdin.flush()
        ready,_,_=select.select([master],[],[],.025)
        if ready:
            try:
                chunk=os.read(master,65536)
                if chunk:data.extend(chunk)
                else:eof=True
            except OSError as error:
                if error.errno!=errno.EIO:raise
                eof=True
        if status is None:
            got,value=os.waitpid(pid,os.WNOHANG)
            if got:status=value;exited=time.monotonic()
        if status is not None and eof:break
    if status is None:
        watchdog=True;os.killpg(pid,signal.SIGKILL);_,status=os.waitpid(pid,0);exited=time.monotonic()
finally:
    os.close(master)
    if status is None:
        os.killpg(pid,signal.SIGKILL);os.waitpid(pid,0)
raw=bytes(data);err=(case/'stderr.log').read_bytes()
(case/'stdout.raw').write_bytes(raw)
remove_events=[e for e in events if e['event']=='remove-held']
released_events=[e for e in events if e['event']=='remove-released']
tail=raw[stdout_at_interrupt:] if sent else b''
plain=re_sub(tail.decode(errors='replace'))
errtail=err if sent else b''
row={'label':'backup-disable-sigint','command':command,'exitCode':os.waitstatus_to_exitcode(status),
     'seconds':round((exited-started)*1000,1) if exited else None,
     'interruptToExitMs':round((exited-sent)*1000,1) if sent and exited else None,
     'interruptSent':sent is not None,'watchdog':watchdog,'ptyEof':eof,
     'removeRequests':len(remove_events),'removesReleased':len(released_events),
     'removesAtClose':max([e.get('removes',0) for e in events if e['event']=='front-closed'], default=0),
     'stdoutAfterInterrupt':plain[:600],
     'stderrTail':errtail.decode(errors='replace')[-300:],
     'stdoutSHA256':__import__('hashlib').sha256(raw).hexdigest()}
receipt['cases'].append(row);save()
# verdict: green -> the admitted git-job removal settles (receipt kept), the
# loop breaks before offsite-job (only 1 remove request), and the CLI reports
# the interruption instead of a false "Scheduled backups disabled."
# base/old -> offsite-job is never removed, but the CLI still prints the
# all-disabled acknowledgement (misleading success) OR the in-flight remove is
# aborted and its receipt is dropped.
if remove_events:
    admitted_settled=len(released_events)>=1
    interrupted_reported=('not reached (interrupted)' in plain)
    no_late_mutations=row['removeRequests']==1
    accepted=(admitted_settled and interrupted_reported and no_late_mutations)
    row['result']='GREEN_RECEIPT_KEPT' if (accepted if expect=='green' else not accepted) else ('RED_ACK_MISLEADING' if expect=='green' else 'GREEN_EXISTING_BASE')
else:
    row['result']='NO_HELD_REQUEST'
receipt['result']=receipt['cases'][0]['result']
save()
print(json.dumps({k:v for k,v in row.items() if k not in ('command','stdoutAfterInterrupt','stderrTail')}),flush=True)
# cleanup
try:
    peer.stdin.write('{"op":"stop"}\n');peer.stdin.flush();peer.wait(timeout=5)
except Exception:
    os.killpg(peer.pid,signal.SIGKILL);peer.wait()
thread.join(timeout=5)
