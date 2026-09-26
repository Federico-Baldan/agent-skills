#!/usr/bin/env bash
# One-time setup of the Telegram alerts: stores the bot token and your chat id as encrypted
# GitHub secrets. The token is read without echoing and never printed or written to disk.
set -euo pipefail

repo="$(node -p "require('./package.json').repository.replace(/^github:/, '')")"
api='https://api.telegram.org'

echo 'Create a bot first: in Telegram, talk to @BotFather, send /newbot and copy the token it gives you.'
read -rsp 'Paste the bot token (hidden): ' token
echo

# Errors are silenced on purpose: we print our own message, and nothing may echo the token.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const out=('"$1"')(JSON.parse(s));if(out==null)process.exit(1);console.log(out)}catch{process.exit(1)}})' 2>/dev/null; }

if ! bot="$(curl -fsS --max-time 20 "$api/bot$token/getMe" 2>/dev/null | json 'r => r.ok ? r.result.username : null')"; then
  echo 'Telegram rejected that token. Copy it again from @BotFather.' >&2
  exit 1
fi

chat_id=''
while [ -z "$chat_id" ]; do
  read -rp "Now open https://t.me/$bot in Telegram, press Start (or send any message), then press Enter here... "
  chat_id="$(curl -fsS --max-time 20 "$api/bot$token/getUpdates" 2>/dev/null \
    | json 'r => { const u = (r.result || []).map((x) => x.message || x.my_chat_member).filter(Boolean); return u.length ? u[u.length - 1].chat.id : null; }' || true)"
  [ -z "$chat_id" ] && echo "No message from you yet; try again."
done

printf '%s' "$token" | gh secret set TELEGRAM_BOT_TOKEN -R "$repo"
printf '%s' "$chat_id" | gh secret set TELEGRAM_CHAT_ID -R "$repo"
echo "Saved TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as secrets of $repo."

gh workflow run notify.yml -R "$repo" -f test=true
echo "Sent a test run; a message from @$bot should reach you in about a minute."
