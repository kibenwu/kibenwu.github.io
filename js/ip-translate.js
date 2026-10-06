(function () {
  var SOURCE = 'zh-CN';
  var SUPPORTED = ['en', 'ja'];
  var COOKIE = 'googtrans';
  var KEY_PICKED = 'langPicked';
  var KEY_IP_TRIED = 'langIpTried';
  var KEY_IP_LANG = 'langIpResult';

  function readCookie(name) {
    var match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return match ? decodeURIComponent(match.pop()) : '';
  }

  function browserPreferred() {
    var languages = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < languages.length; i++) {
      var tag = (languages[i] || '').toLowerCase();
      if (tag.indexOf('zh') === 0) return null;
      if (tag.indexOf('ja') === 0) return 'ja';
      if (tag.indexOf('en') === 0) return 'en';
    }
    return null;
  }

  function detectCountryLang() {
    return new Promise(function (resolve) {
      try {
        var cached = sessionStorage.getItem(KEY_IP_LANG);
        if (cached) {
          resolve(cached === 'null' ? null : cached);
          return;
        }
      } catch (e) {}

      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, 3000);

      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://ipapi.co/json/', true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || done) return;
        done = true;
        clearTimeout(timer);

        var lang = null;
        try {
          if (xhr.status === 200) {
            var country = (JSON.parse(xhr.responseText).country_code || '').toUpperCase();
            if (country === 'JP') {
              lang = 'ja';
            } else if (country !== 'CN' && country !== 'HK' && country !== 'TW' && country !== 'MO') {
              lang = 'en';
            }
            try { sessionStorage.setItem(KEY_IP_LANG, lang || 'null'); } catch (e) {}
          }
        } catch (e) {
          lang = browserPreferred();
        }
        resolve(lang);
      };
      xhr.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(browserPreferred());
      };
      xhr.send();
    });
  }

  var target = readCookie(COOKIE).split('/')[2] || '';
  if (SUPPORTED.indexOf(target) > -1) return;

  try {
    if (localStorage.getItem(KEY_PICKED) || sessionStorage.getItem(KEY_IP_TRIED)) return;
    sessionStorage.setItem(KEY_IP_TRIED, '1');
  } catch (e) {}

  detectCountryLang().then(function (lang) {
    if (!lang) return;
    document.cookie = COOKIE + '=/' + SOURCE + '/' + lang + ';path=/';
    location.reload();
  });
})();