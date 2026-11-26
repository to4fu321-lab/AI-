/**
 * gofile.io で押すと、そのブラウザの Gofile のトークン（ゲスト、またはログイン中のアカウント）を、このアプリに渡すブックマークレット。
 *
 * Gofile はトークンをしまう場所を変えることがあるので、決め打ちせずに広く探す：
 *   - Cookie（名前に token・account を含むもの）
 *   - ブラウザの保存場所（localStorage・sessionStorage）。値が JSON なら中まで
 *   - ページの中のデータ（window.appdata など）
 * それでも見つからなければ、My Profile の「API token」のコピーボタンでコピーしたものを貼り付けてもらう。
 * トークンはアドレスの「#」より後ろで渡すので、サーバーには送られない（受け取ったらすぐアドレスから消す）。
 */
const BODY = String.raw`(function(o){
if(!/(^|\.)gofile\.io$/.test(location.hostname)){alert('gofile.io のページを開いてから押してください');return;}
var ok=/^[A-Za-z0-9]{20,128}$/,t=null;
function scan(k,v,d){
  if(t||d>5||v==null)return;
  if(typeof v==='string'){
    if(ok.test(v)&&/token|account/i.test(k)){t=v;return;}
    var c=v.charAt(0);
    if(c==='{'||c==='['){try{scan(k,JSON.parse(v),d+1);}catch(e){}}
    return;
  }
  if(typeof v==='object'){try{for(var x in v){scan(x,v[x],d+1);if(t)return;}}catch(e){}}
}
document.cookie.split(';').forEach(function(p){var i=p.indexOf('=');if(i>0){var v=p.slice(i+1);try{v=decodeURIComponent(v);}catch(e){}scan(p.slice(0,i).trim(),v,0);}});
[window.localStorage,window.sessionStorage].forEach(function(s){try{for(var i=0;i<s.length;i++){var k=s.key(i);scan(k,s.getItem(k),0);}}catch(e){}});
['appdata','appData','gofile','__NEXT_DATA__'].forEach(function(n){try{scan(n,window[n],0);}catch(e){}});
if(!t){
  var p=prompt('トークンを自動では見つけられませんでした。\nGofile の「My Profile」の「API token」の横のコピーボタンを押してから、ここに貼り付けてください');
  if(p===null)return;
  t=String(p).trim();
}
if(!/^[A-Za-z0-9]{10,128}$/.test(t)){alert('トークンの形が正しくありません（英数字だけのはずです）');return;}
location.href=o+'/thumbs#gofile-token='+t;
})`;

export function gofileTokenBookmarklet(appOrigin: string): string {
  // ブックマークの URL に入れるので、改行と余分な空白を詰める
  const code = BODY.replace(/\n\s*/g, "");
  return `javascript:${code}(${JSON.stringify(appOrigin)});`;
}

/**
 * X の検索結果（ログインしている本人のブラウザ）で押すと、画面を少しずつ下へ動かしながら Gofile のリンクを集め、
 * このアプリへ渡すブックマークレット。X は画面に見えている投稿しかページに残さないので、動かしながら集める。
 * 集めたフォルダの番号はアドレスの「#」より後ろで渡す（サーバーには送られない）
 */
const X_BODY = String.raw`(function(o){
if(!/(^|\.)(x|twitter)\.com$/.test(location.hostname)){alert('X（x.com）の検索結果を開いてから押してください');return;}
var ids={},n=0,still=0,round=0;
var box=document.createElement('div');
box.style.cssText='position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;background:#0ea5e9;color:#fff;font:bold 14px sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.3)';
document.body.appendChild(box);
function grab(){
  var t=(document.body.innerText||'')+' ';
  document.querySelectorAll('a[href],[title]').forEach(function(a){t+=' '+(a.getAttribute('title')||'')+' '+(a.textContent||'');});
  var re=/gofile\.io\/d\/([A-Za-z0-9_-]{4,40})/g,m,before=n;
  while((m=re.exec(t))){if(!ids[m[1]]){ids[m[1]]=1;n++;}}
  return n>before;
}
function step(){
  round++;
  still=grab()?0:still+1;
  box.textContent='🔎 Gofile のリンクを集めています… '+n+' 件（'+round+'/30）';
  if(round<30&&still<5){window.scrollBy(0,Math.round(innerHeight*0.9));setTimeout(step,1300);return;}
  box.remove();
  var list=Object.keys(ids);
  if(!list.length){alert('Gofile のリンクが見つかりませんでした（検索結果が表示されてから、もう一度押してください）');return;}
  location.href=o+'/thumbs#gofile-ids='+list.slice(0,200).join(',')+'&from='+encodeURIComponent(location.href.slice(0,500));
}
step();
})`;

export function xGofileBookmarklet(appOrigin: string): string {
  return `javascript:${X_BODY.replace(/\n\s*/g, "")}(${JSON.stringify(appOrigin)});`;
}

/** X の検索：Gofile のリンクを含む投稿を、新しい順に（hours 時間以内） */
export function xGofileSearchUrl(hours: number): string {
  const q = `url:gofile.io within_time:${hours}h`;
  return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
}
