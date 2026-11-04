// Llamadas al servidor de la consola y la encuesta. El servidor puede cortar una respuesta por un momento (límite de CPU de Cloudflare:
// 503 sin cabeceras CORS, que el navegador solo muestra como «Failed to fetch»).
// - Consultas (GET): se reintentan solas; no cambian nada, así que repetirlas es seguro.
// - Escrituras (POST): NO se reintentan: el servidor pudo haberlas aplicado aunque la respuesta no llegara, y repetirlas podría duplicarlas.
(function (raiz) {
  var PAUSAS = [800, 2000];
  var TEMPORALES = [502, 503, 504];
  var SIN_LECTURA = 'El servidor no respondió al traer los datos. Recarga la página en unos segundos: lo que ya se guardó no se pierde.';
  var SIN_ESCRITURA = 'El servidor no respondió y no pudimos confirmar si el cambio se guardó. Recarga la página para revisarlo antes de repetirlo.';

  function esperaReal(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  // dep (opcional, para las pruebas): {fetch, esperar}
  function pedir(url, opt, dep) {
    opt = opt || {}; dep = dep || {};
    var hacer = dep.fetch || function (u, o) { return raiz.fetch(u, o); }, esperar = dep.esperar || esperaReal;
    var lectura = !opt.method || opt.method === 'GET';
    function intento(n) {
      var otra = lectura && n < PAUSAS.length;
      return hacer(url, opt).then(function (r) {
        if (otra && TEMPORALES.indexOf(r.status) >= 0) return esperar(PAUSAS[n]).then(function () { return intento(n + 1); });
        return r;
      }, function (err) {
        if (err && err.name === 'AbortError') throw err;
        if (otra) return esperar(PAUSAS[n]).then(function () { return intento(n + 1); });
        var e = new Error(lectura ? SIN_LECTURA : SIN_ESCRITURA);
        e.sinRespuesta = true;
        throw e;
      });
    }
    return intento(0);
  }

  raiz.pedirServidor = pedir;
  if (typeof module !== 'undefined' && module.exports) module.exports = { pedir: pedir, SIN_LECTURA: SIN_LECTURA, SIN_ESCRITURA: SIN_ESCRITURA };
})(typeof window !== 'undefined' ? window : globalThis);
