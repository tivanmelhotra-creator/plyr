#!/usr/bin/env bash
# Phase 1 end-to-end on a REAL server (Redis + Xvfb/openbox + Playwright Chromium-1194).
# Usage: tools/s27/e2e.sh > artifacts/s27-e2e.log
B=http://localhost:3000; J='-H Content-Type:application/json'
pid() { curl -s $B/profiles | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const p=j.profiles.find(p=>p.name===process.argv[1]);console.log(p?p.id:"")})' "$1"; }
sess() { curl -s $B/browser/sessions | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("  local="+j.localBrowser.running+" sessions=["+j.sessions.map(s=>s.name+"("+s.kind+",views="+s.views+",runs="+s.runs+")").join(", ")+"]")})'; }
wins() { DISPLAY=:99 wmctrl -l -p 2>/dev/null | while read id d p rest; do echo "  window $id pid=$p dir=$(tr '\0' '\n' </proc/$p/cmdline 2>/dev/null | grep -- --user-data-dir= | sed 's#.*/profiles/##')"; done; }
echo "== B. create '22' with Local Browser OFF"; sess
curl -s $J -X POST $B/profiles -d '{"name":"22","workflowId":"wf_e2e01"}' -o /dev/null -w "  create=%{http_code}\n"
P22=$(pid 22); echo "  id=$P22"
curl -s $J -X POST $B/profiles/$P22/open -d '{"workflowId":"wf_e2e01"}' | head -c 220; echo
sleep 4; echo "  4 s later:"; sess; wins
echo "  chromium display name: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).profile.info_cache.Default.name)' "profiles/local/browser-profiles/$P22/Local State")"
echo "== A/E. 'Shop B' with Automation preset + --lang=fa"
curl -s $J -X POST $B/profiles -d '{"name":"Shop B"}' -o /dev/null; PB=$(pid "Shop B")
curl -s $J -X POST $B/profiles/$PB/open -d '{"workflowId":"wf_e2e01","launch":{"preset":"automation","customFlags":"--lang=fa"}}' | head -c 160; echo
sleep 2; wins; sess
for p in $(pgrep -f "browser-profiles/$PB" | head -1); do tr '\0' '\n' </proc/$p/cmdline | grep -E -- "--user-data-dir|--no-first-run|--lang|--disable-background-timer|--headless" | sed 's#=.*/profiles/#=.../profiles/#;s/^/  arg /'; done
for p in $(pgrep -f "browser-profiles/$P22" | head -1); do echo "  22 has --no-first-run? $(tr '\0' '\n' </proc/$p/cmdline | grep -c -- --no-first-run)"; done
echo "== E. invalid flags"
curl -s $J -X POST $B/profiles/$PB/open -d '{"workflowId":"wf_e2e01","launch":{"customFlags":"--user-data-dir=/tmp/x\n--headless"}}' | head -c 330; echo
echo "== D. Turn on Local Browser, then Turn off with 2 profile browsers open"
curl -s $J -X POST $B/browser/real/open -d '{}' -o /dev/null -w "  turn-on=%{http_code}\n"; sleep 2; sess
S=$(date +%s%N); curl -s -m 40 $J -X POST $B/browser/real/close -d '{}' | head -c 260; echo; echo "  turn-off took $(( ($(date +%s%N)-S)/1000000 )) ms"
sleep 1; sess; wins
echo "== A6. close 22; Shop B keeps running"
curl -s $J -X POST $B/profiles/$P22/close -d '{"workflowId":"wf_e2e01"}'; echo; sleep 1; sess; wins
echo "== A7. reopen 22: same dir, saved state kept"
curl -s $J -X POST $B/profiles/$P22/open -d '{"workflowId":"wf_e2e01"}' | head -c 100; echo
ls "profiles/local/browser-profiles/$P22/.plyr-state" 2>&1 | sed 's/^/  /'
echo "== F. release != close; close != release"
curl -s $J -X POST $B/profiles/$PB/release -d '{"workflowId":"wf_e2e01"}'; echo; sess
echo DONE
