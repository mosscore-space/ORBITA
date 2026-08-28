/* =========================================================
   Orbita — shared auth helper
   ---------------------------------------------------------
   The password is never stored as plain text — only its
   SHA-256 hash lives here. This is a static site with no
   server, so this is a "keep out" sign for casual visitors,
   not real security: anyone with the URL can read this file
   and see exactly how the check works. The real privacy
   boundary is who you give the URL/repo access to, not this
   screen.
   ========================================================= */
const ORBITA_AUTH = {
  username: 'shaiman',
  // SHA-256 of the account password — the password itself is not in this file.
  hash: '1995f6ddc8b63c7cbdb4fd8931ea2dab54daecac20a696afb113852fb11c739c',
};
const SESSION_KEY = 'orbita-authed';

async function sha256Hex(message){
  if(!(window.crypto && window.crypto.subtle)){
    throw new Error('This browser cannot check the password securely (needs HTTPS or localhost).');
  }
  const bytes = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function isAuthed(){ return sessionStorage.getItem(SESSION_KEY) === '1'; }
function setAuthed(){ sessionStorage.setItem(SESSION_KEY, '1'); }
function clearAuthed(){ sessionStorage.removeItem(SESSION_KEY); }
