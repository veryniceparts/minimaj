// Runs before the page draws (a classic, blocking script): apply the saved color
// theme so the page doesn't flash the default one. Kept out of index.html so the
// Content-Security-Policy can allow only this site's own script files.
try{var t=localStorage.getItem('minimaj-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}
