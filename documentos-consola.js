/* Consola de MBC · documentos: carga masiva (selección múltiple y arrastrar/soltar), bandeja con filtros y clasificación en procesos con ayuda de la IA.
 * Se carga desde admin.html y recibe lo que necesita de la consola en DocumentosConsola.iniciar(); pinta en el contenedor que le pasan.
 */
(function(){
  'use strict';
  var X = null;                     // lo que entrega la consola (api, datos, esc, fecha, base, codigo)
  var RAIZ = null;                  // contenedor de la pestaña
  var ST = {docs: [], umbral: 0.7, gerencias: [], resumen: {}, abierto: '', cargando: false, subiendo: false, resultados: [], filtros: {gerencia: '', estado: '', estado_ia: '', confianza: '', desde: '', hasta: '', q: '', prioridad: false}};
  var TIPOS = {pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png'};
  var MAX_IMAGEN = 6 * 1024 * 1024, MAX_OTROS = 10 * 1024 * 1024;

  function esc(s){ return X.esc(s); }
  function $(s){ return RAIZ.querySelector(s); }
  function iniciar(opciones){ X = opciones; }
  function nombreProc(p){ return p.subproceso || p.proceso || p.macroproceso || '(sin nombre)'; }
  function pct(n){ return Math.round(n * 100) + '%'; }
  function extension(n){ var m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; }

  // Gerencias de la campaña: las de los procesos, las de la estructura y las de las personas.
  function gerenciasCampana(){
    var C = X.datos(), s = {};
    C.procesos.forEach(function(p){ if (p.gerencia) s[p.gerencia] = 1; });
    (C.estructura || []).forEach(function(f){ if (f.gerencia) s[f.gerencia] = 1; });
    C.encuestados.forEach(function(e){ if (e.gerencia) s[e.gerencia] = 1; });
    return Object.keys(s).sort(function(a, b){ return a.localeCompare(b, 'es'); });
  }
  function opciones(lista, actual, vacio){
    return (vacio == null ? '' : '<option value="">' + esc(vacio) + '</option>') + lista.map(function(g){ return '<option' + (g === actual ? ' selected' : '') + '>' + esc(g) + '</option>'; }).join('');
  }

  // ---------------------------------------------------------------- validación antes de subir
  function validar(f){
    var ext = extension(f.name);
    if (!TIPOS[ext]) return 'Formato no permitido (usa PDF, Word .docx, JPG o PNG)';
    if (!f.size) return 'El archivo está vacío';
    if (f.size > (ext === 'pdf' || ext === 'docx' ? MAX_OTROS : MAX_IMAGEN)) return 'Pesa demasiado (máximo ' + (ext === 'pdf' || ext === 'docx' ? '10' : '6') + ' MB)';
    return '';
  }

  // Cada archivo se manda por separado: si uno falla, los demás siguen. El resultado de cada uno queda a la vista.
  function subirTodos(archivos){
    var ger = ($('#dcGer') || {}).value || '';
    if (!ger){ avisoCarga('Selecciona una gerencia antes de cargar.'); return; }
    if (!archivos.length || ST.subiendo) return;
    ST.subiendo = true; ST.resultados = archivos.map(function(f){ var e = validar(f); return {nombre: f.name, estado: e ? 'error' : 'espera', msg: e}; });
    pintarResultados();
    var cadena = Promise.resolve();
    archivos.forEach(function(f, i){
      var r = ST.resultados[i];
      if (r.estado === 'error') return;
      cadena = cadena.then(function(){
        r.estado = 'subiendo'; pintarResultados();
        return fetch(X.base() + '/a/documentos?campana_id=' + encodeURIComponent(X.datos().campana.id) + '&gerencia=' + encodeURIComponent(ger) + '&nombre=' + encodeURIComponent(f.name),
          {method: 'POST', headers: {'x-admin-code': X.codigo(), 'content-type': TIPOS[extension(f.name)]}, body: f})
          .then(function(resp){ return resp.json().catch(function(){ return {ok: false, error: 'Respuesta inesperada'}; }).then(function(j){ if (!resp.ok || !j.ok) throw new Error(j.error || ('Error ' + resp.status)); }); })
          .then(function(){ r.estado = 'ok'; r.msg = 'Cargado · Pendiente de clasificación'; })
          .catch(function(err){ r.estado = 'error'; r.msg = err.message; })
          .then(pintarResultados);
      });
    });
    cadena.then(function(){ ST.subiendo = false; pintarResultados(); return recargar(); });
  }
  function avisoCarga(t){ var m = $('#dcMsg'); if (m) m.textContent = t; }
  function pintarResultados(){
    var c = $('#dcRes'); if (!c) return;
    var chip = {espera: ['c-mut', 'En espera'], subiendo: ['c-inf', 'Subiendo…'], ok: ['c-ok', 'Cargado'], error: ['c-warn', 'Con error']};
    c.innerHTML = ST.resultados.length ? '<div class="tblwrap"><table><thead><tr><th>Archivo</th><th>Resultado</th></tr></thead><tbody>' + ST.resultados.map(function(r){
      return '<tr><td>' + esc(r.nombre) + '</td><td><span class="chip ' + chip[r.estado][0] + '">' + chip[r.estado][1] + '</span> <span class="muted">' + esc(r.msg || '') + '</span></td></tr>'; }).join('') + '</tbody></table></div>' : '';
  }

  // ---------------------------------------------------------------- bandeja
  function consulta(){
    var f = ST.filtros, q = ['campana_id=' + encodeURIComponent(X.datos().campana.id)];
    ['gerencia', 'estado', 'estado_ia', 'confianza', 'desde', 'hasta', 'q'].forEach(function(k){ if (f[k]) q.push(k + '=' + encodeURIComponent(f[k])); });
    if (f.prioridad) q.push('orden=confianza');
    return '/a/documentos?' + q.join('&');
  }
  function recargar(){
    ST.cargando = true; pintarBandeja();
    return X.api(consulta()).then(function(j){ ST.docs = j.documentos; ST.umbral = j.umbral; ST.gerencias = j.gerencias; ST.resumen = j.resumen || {}; })
      .catch(function(err){ aviso(err.message); })
      .then(function(){ ST.cargando = false; pintarBandeja(); });
  }
  function aviso(t){ var m = $('#dbMsg'); if (m) m.textContent = t || ''; }

  function chipsEstado(d){
    var h = '<span class="chip ' + (d.estado === 'clasificado' ? 'c-ok' : 'c-mut') + '">' + (d.estado === 'clasificado' ? 'Clasificado' : 'Pendiente de clasificación') + '</span>';
    return h;
  }
  function chipsIA(d){
    var h = d.estado_ia === 'analizado' ? '<span class="chip c-inf">Analizado por IA</span>' : d.estado_ia === 'error' ? '<span class="chip c-warn">Análisis con error</span>' : '<span class="chip c-mut">Sin analizar</span>';
    if (d.baja_confianza) h += ' <span class="chip c-warn" title="Alguna sugerencia está por debajo del umbral de ' + pct(ST.umbral) + '">Baja confianza</span>';
    return h;
  }
  function chipsProcesos(d){
    if (!d.procesos.length) return '<span class="muted">—</span>';
    return d.procesos.map(function(p){
      var cls = p.confirmado ? 'c-ok' : p.baja ? 'c-warn' : 'c-inf';
      return '<span class="chip ' + cls + '" title="' + esc(p.gerencia || '') + (p.confirmado ? ' · confirmado' : ' · sugerido por la IA') + '">' + esc(p.nombre) + (p.confianza != null ? ' · ' + pct(p.confianza) : '') + '</span>';
    }).join(' ');
  }

  function pintarBandeja(){
    var c = $('#dbLista'); if (!c) return;
    var r = ST.resumen;
    $('#dbResumen').textContent = (r.pendiente || 0) + ' pendientes de clasificación · ' + (r.clasificado || 0) + ' clasificados';
    if (ST.cargando && !ST.docs.length){ c.innerHTML = '<p class="muted">Cargando…</p>'; return; }
    if (!ST.docs.length){ c.innerHTML = '<p class="muted">No hay documentos con esos filtros.</p>'; return; }
    c.innerHTML = '<div class="tblwrap"><table><thead><tr><th>Documento</th><th>Gerencia</th><th>Cargado</th><th>Estado</th><th>Análisis IA</th><th>Procesos</th><th></th></tr></thead><tbody>' + ST.docs.map(function(d){
      var fila = '<tr data-id="' + esc(d.id) + '"><td><button class="btn btn-ghost btn-xs" data-acc="abrir" title="Abrir el documento">' + esc(d.nombre) + '</button><div class="muted">' + esc(d.tipo.toUpperCase()) + '</div></td>' +
        '<td>' + esc(d.gerencia) + ' <button class="btn btn-ghost btn-xs" data-acc="gerencia" title="Cambiar la gerencia">Cambiar</button></td>' +
        '<td>' + esc(X.fecha(d.creado)) + '<div class="muted">' + esc(d.cargado_por) + '</div></td>' +
        '<td>' + chipsEstado(d) + '</td><td>' + chipsIA(d) + '</td><td>' + chipsProcesos(d) + '</td>' +
        '<td style="white-space:nowrap"><button class="btn btn-ghost btn-xs" data-acc="analizar"' + (ST.analizando === d.id ? ' disabled' : '') + '>' + (ST.analizando === d.id ? 'Analizando…' : d.estado_ia === 'analizado' ? 'Volver a analizar' : 'Analizar con IA') + '</button> ' +
        '<button class="btn btn-navy btn-xs" data-acc="clasificar">' + (ST.abierto === d.id ? 'Cerrar' : 'Clasificar') + '</button></td></tr>';
      return fila + (ST.abierto === d.id ? '<tr><td colspan="7" id="dbPanel"></td></tr>' : '');
    }).join('') + '</tbody></table></div>';
    if (ST.abierto) pintarPanel();
  }

  // Panel de clasificación: la lista final de procesos del documento (lo sugerido viene marcado; se puede quitar o agregar).
  function pintarPanel(){
    var cont = $('#dbPanel'), d = ST.docs.filter(function(x){ return x.id === ST.abierto; })[0];
    if (!cont || !d) return;
    var marcados = {}; d.procesos.forEach(function(p){ marcados[p.proceso_id] = p; });
    var sel = ST.sel || (ST.sel = Object.keys(marcados).reduce(function(o, k){ o[k] = 1; return o; }, {}));
    var q = (ST.busca || '').toLowerCase();
    var lista = X.datos().procesos.filter(function(p){ return sel[p.id] || !q || (p.gerencia + ' ' + p.seccion + ' ' + nombreProc(p) + ' ' + p.proceso + ' ' + p.macroproceso).toLowerCase().indexOf(q) >= 0; })
      .sort(function(a, b){ return (sel[b.id] ? 1 : 0) - (sel[a.id] ? 1 : 0) || a.gerencia.localeCompare(b.gerencia, 'es') || nombreProc(a).localeCompare(nombreProc(b), 'es'); }).slice(0, 80);
    cont.innerHTML = '<div class="muted" style="margin-bottom:6px">Marca los procesos que corresponden al documento. Los sugeridos por la IA muestran su confianza; desmarca los incorrectos o busca otros para agregarlos.</div>' +
      '<input type="search" id="dbBusca" placeholder="Buscar proceso, gerencia o sección…" value="' + esc(ST.busca || '') + '" style="max-width:380px">' +
      '<div style="max-height:260px;overflow:auto;margin:8px 0">' + (lista.length ? lista.map(function(p){
        var s = marcados[p.id];
        return '<label style="display:block;padding:3px 0"><input type="checkbox" data-pid="' + esc(p.id) + '"' + (sel[p.id] ? ' checked' : '') + '> ' + esc(nombreProc(p)) + ' <span class="muted">· ' + esc(p.gerencia) + ' / ' + esc(p.seccion) + '</span>' +
          (s && s.origen === 'ia' ? ' <span class="chip ' + (s.baja ? 'c-warn' : 'c-inf') + '">IA ' + pct(s.confianza) + '</span>' : '') + '</label>';
      }).join('') : '<span class="muted">Ningún proceso coincide.</span>') + '</div>' +
      '<div class="row"><button class="btn btn-navy btn-xs" data-acc="confirmar">Confirmar clasificación (' + Object.keys(sel).length + ')</button> <span class="muted">Sin procesos marcados, el documento vuelve a Pendiente.</span></div>';
    var b = $('#dbBusca'); if (b && ST.enfocar){ b.focus(); b.setSelectionRange(b.value.length, b.value.length); ST.enfocar = false; }
  }

  function actuar(id, acc){
    var d = ST.docs.filter(function(x){ return x.id === id; })[0]; if (!d) return;
    if (acc === 'abrir'){
      fetch(X.base() + '/a/documentos/archivo?id=' + encodeURIComponent(id), {headers: {'x-admin-code': X.codigo()}})
        .then(function(r){ if (!r.ok) return r.json().then(function(j){ throw new Error(j.error || 'No se pudo abrir'); }); return r.blob(); })
        .then(function(b){ window.open(URL.createObjectURL(b), '_blank', 'noopener'); })
        .catch(function(err){ aviso(err.message); });
    } else if (acc === 'gerencia'){
      var g = window.prompt('Nueva gerencia para «' + d.nombre + '»:\n' + gerenciasCampana().join(', '), d.gerencia);
      if (g && g !== d.gerencia) X.api('/a/documentos/gerencia', {id: id, gerencia: g}).then(recargar).catch(function(err){ aviso(err.message); });
    } else if (acc === 'analizar'){
      ST.analizando = id; aviso(''); pintarBandeja();
      X.api('/a/documentos/analizar', {id: id}).catch(function(err){ aviso(err.message); }).then(function(){ ST.analizando = ''; ST.sel = null; return recargar(); });
    } else if (acc === 'clasificar'){
      ST.abierto = ST.abierto === id ? '' : id; ST.sel = null; ST.busca = ''; pintarBandeja();
    } else if (acc === 'confirmar'){
      var ids = Object.keys(ST.sel || {});
      X.api('/a/documentos/procesos', {id: id, procesos: ids}).then(function(){ ST.abierto = ''; ST.sel = null; aviso(ids.length ? 'Clasificación confirmada.' : 'El documento volvió a Pendiente.'); return recargar(); }).catch(function(err){ aviso(err.message); });
    }
  }

  // ---------------------------------------------------------------- pestaña
  function pintar(contenedor){
    RAIZ = contenedor;
    var f = ST.filtros;
    RAIZ.innerHTML =
      '<div class="card" style="margin:0 0 14px"><h3 style="margin-top:0">Carga masiva de documentos</h3>' +
      '<div class="row"><div><label for="dcGer">Gerencia (obligatoria)</label><select id="dcGer">' + opciones(gerenciasCampana(), '', 'Selecciona una gerencia…') + '</select></div></div>' +
      '<div id="dcZona" tabindex="0" role="button" aria-label="Arrastra los archivos aquí o presiona para seleccionarlos" style="margin:10px 0;border:2px dashed var(--line,#c9d1dc);border-radius:10px;padding:22px;text-align:center;cursor:pointer">' +
      'Arrastra aquí los archivos o <u>selecciónalos</u><div class="muted">PDF, Word (.docx), JPG o PNG · hasta 10 MB (imágenes 6 MB) · todos quedan «Pendiente de clasificación»</div>' +
      '<input type="file" id="dcArch" multiple accept=".pdf,.docx,.jpg,.jpeg,.png" class="hidden"></div>' +
      '<div class="muted" id="dcMsg" role="status"></div><div id="dcRes"></div></div>' +
      '<div class="card" style="margin:0"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Bandeja de documentos</h3><span class="muted" id="dbResumen"></span></div>' +
      '<div class="filtros" style="margin-top:10px">' +
      '<div><label for="dfQ">Buscar</label><input type="search" id="dfQ" placeholder="Nombre del archivo…" value="' + esc(f.q) + '"></div>' +
      '<div><label for="dfGer">Gerencia</label><select id="dfGer">' + opciones(gerenciasCampana(), f.gerencia, 'Todas') + '</select></div>' +
      '<div><label for="dfEst">Estado</label><select id="dfEst"><option value="">Todos</option><option value="pendiente"' + (f.estado === 'pendiente' ? ' selected' : '') + '>Pendiente de clasificación</option><option value="clasificado"' + (f.estado === 'clasificado' ? ' selected' : '') + '>Clasificado</option></select></div>' +
      '<div><label for="dfIA">Análisis IA</label><select id="dfIA"><option value="">Todos</option><option value="sin_analizar"' + (f.estado_ia === 'sin_analizar' ? ' selected' : '') + '>Sin analizar</option><option value="analizado"' + (f.estado_ia === 'analizado' ? ' selected' : '') + '>Analizado</option><option value="error"' + (f.estado_ia === 'error' ? ' selected' : '') + '>Con error</option></select></div>' +
      '<div><label for="dfConf">Confianza</label><select id="dfConf"><option value="">Todas</option><option value="baja"' + (f.confianza === 'baja' ? ' selected' : '') + '>Baja (bajo el umbral)</option><option value="sin"' + (f.confianza === 'sin' ? ' selected' : '') + '>Sin sugerencias</option></select></div>' +
      '<div><label for="dfDesde">Desde</label><input type="date" id="dfDesde" value="' + esc(f.desde) + '"></div>' +
      '<div><label for="dfHasta">Hasta</label><input type="date" id="dfHasta" value="' + esc(f.hasta) + '"></div></div>' +
      '<div class="row" style="margin:8px 0"><label><input type="checkbox" id="dfPrio"' + (f.prioridad ? ' checked' : '') + '> Revisar primero los de menor confianza</label>' +
      '<span class="muted" style="margin-left:auto">Umbral de baja confianza</span><input type="number" id="dfUmbral" min="0" max="100" step="5" value="' + Math.round(ST.umbral * 100) + '" style="width:72px" aria-label="Umbral de baja confianza en porcentaje">%' +
      '<button class="btn btn-ghost btn-xs" id="dfGuardaUmbral">Guardar umbral</button></div>' +
      '<div class="muted" id="dbMsg" role="status"></div><div id="dbLista"></div></div>';
    enlazar();
    pintarResultados();
    recargar();
  }

  function enlazar(){
    var zona = $('#dcZona'), inp = $('#dcArch');
    zona.addEventListener('click', function(){ inp.click(); });
    zona.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); inp.click(); } });
    inp.addEventListener('change', function(){ subirTodos(Array.prototype.slice.call(inp.files)); inp.value = ''; });
    ['dragenter', 'dragover'].forEach(function(n){ zona.addEventListener(n, function(e){ e.preventDefault(); zona.style.background = 'var(--accent-soft,#eef3ff)'; }); });
    ['dragleave', 'drop'].forEach(function(n){ zona.addEventListener(n, function(e){ e.preventDefault(); zona.style.background = ''; }); });
    zona.addEventListener('drop', function(e){ subirTodos(Array.prototype.slice.call(e.dataTransfer.files)); });
    var campos = {dfQ: 'q', dfGer: 'gerencia', dfEst: 'estado', dfIA: 'estado_ia', dfConf: 'confianza', dfDesde: 'desde', dfHasta: 'hasta'}, t = null;
    Object.keys(campos).forEach(function(id){
      $('#' + id).addEventListener(id === 'dfQ' ? 'input' : 'change', function(e){ ST.filtros[campos[id]] = e.target.value; clearTimeout(t); t = setTimeout(recargar, id === 'dfQ' ? 300 : 0); });
    });
    $('#dfPrio').addEventListener('change', function(e){ ST.filtros.prioridad = e.target.checked; recargar(); });
    $('#dfGuardaUmbral').addEventListener('click', function(){
      var v = Number($('#dfUmbral').value);
      if (!(v >= 0 && v <= 100)){ aviso('El umbral va de 0 a 100.'); return; }
      X.api('/a/campana/umbral', {campana_id: X.datos().campana.id, umbral: v / 100}).then(function(){ aviso('Umbral guardado.'); return recargar(); }).catch(function(err){ aviso(err.message); });
    });
    $('#dbLista').addEventListener('click', function(e){
      var b = e.target.closest('[data-acc]'); if (!b) return;
      var fila = b.closest('tr'), id = ST.abierto && b.dataset.acc === 'confirmar' ? ST.abierto : fila && fila.dataset.id;
      if (id) actuar(id, b.dataset.acc);
    });
    $('#dbLista').addEventListener('change', function(e){
      var p = e.target.dataset && e.target.dataset.pid; if (!p) return;
      ST.sel = ST.sel || {}; if (e.target.checked) ST.sel[p] = 1; else delete ST.sel[p];
      var b = $('[data-acc="confirmar"]'); if (b) b.textContent = 'Confirmar clasificación (' + Object.keys(ST.sel).length + ')';
    });
    $('#dbLista').addEventListener('input', function(e){ if (e.target.id === 'dbBusca'){ ST.busca = e.target.value; ST.enfocar = true; pintarPanel(); } });
  }

  window.DocumentosConsola = {iniciar: iniciar, pintar: pintar};
})();
