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
