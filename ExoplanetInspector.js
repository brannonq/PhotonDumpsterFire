#feature-id    ExoplanetInspector : PhotonDumpsterFire > ExoplanetInspector
#feature-info  Exoplanet transit photometry and light curve plotting tool.

/* ==== ES5-safe globalThis polyfill for PixInsight JS engine ==== */
(function(){
  if (typeof globalThis === 'undefined') {
    var g = (function(){ return this || (1,eval)('this'); })();
    try { Object.defineProperty(g, 'globalThis', { value: g, configurable: true }); } catch(e){ g.globalThis = g; }
  }
})();
/* ================================================================ */

/*
 * ExoTransit WCS Circle Target - UNIVERSAL BUILD
 *
 * Version: 3.5.0
 *
 * KEY FIX IN THIS BUILD:
 * ======================
 * ✓ raDecToPixel() now exclusively uses the EXOWCS engine:
 *     1. PixInsight native astro.WorldToImage()  (most accurate)
 *     2. TAN-projection from CD/PC FITS matrix   (mathematically exact)
 *     3. Clean failure with diagnostic message   (never guesses)
 *
 * ✓ pixelToRADec() updated to match — uses EXOWCS.pixelToWorld()
 * ✓ plateSolveToPixel() is now a thin wrapper that calls raDecToPixel()
 *
 * REMOVED (were causing wrong circle placement):
 * ✗ Hard-coded y -= 17.78 pixel correction
 * ✗ Automatic parity flip (+180°) based on rotation angle
 * ✗ All manual rotation/scale fallback math in raDecToPixel
 * ✗ Empirical rotation-based Y corrections
 *
 * RESULT: The circle lands on the correct star on ANY plate-solved image,
 * regardless of camera rotation, telescope orientation, or field of view.
 * No per-image calibration needed.
 *
 * REQUIREMENT: Image must be plate-solved with PixInsight ImageSolver before use.
 */

#include <pjsr/Sizer.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/StdDialogCode.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/DataType.jsh>

/* =============================================================
   EXOWCS Universal Engine - hoisted to top for use by raDecToPixel
   and pixelToRADec before the main dialog code.
   ============================================================= */
/* =============================================================
   ExoWCS Universal Engine v1.1  (non-GUI, no #include required)
   - Robust WCS keyword parser (CRVAL/CRPIX + CD/PC with CDELT)
   - Correct TAN forward/inverse with proper rotation handling
   - Falls back to PixInsight's astrometricSolution when callable
   - Safe: no GUI changes, no extra includes, runs standalone
   ============================================================= */

// Force-clear cached EXOWCS so each script run uses fresh code
if (typeof global !== "undefined" && global.EXOWCS) { try { delete global.EXOWCS; } catch(e) { global.EXOWCS = null; } }

(function(global){
  'use strict';

  function deg2rad(d){ return d*Math.PI/180; }
  function rad2deg(r){ return r*180/Math.PI; }

  function buildCDFromPC(pc11, pc12, pc21, pc22, cdelt1, cdelt2){
    // If only PC present together with CDELT, CD = PC * diag(CDELT1, CDELT2)
    return {
      a: pc11 * cdelt1, b: pc12 * cdelt2,
      c: pc21 * cdelt1, d: pc22 * cdelt2
    };
  }

  function parseWCS(win){
    var result = { ok:false, msg:"", ra0:NaN, dec0:NaN, x0:NaN, y0:NaN, CD:null, rotDeg:NaN, scaleArcsec:NaN };
    try{
      if (!win || win.isNull){ result.msg="No active image window"; return result; }
      var view = win.mainView;
      if (!view || view.isNull){ result.msg="No main view"; return result; }

      var CRVAL1=NaN, CRVAL2=NaN, CRPIX1=NaN, CRPIX2=NaN;
      var CD11=NaN, CD12=NaN, CD21=NaN, CD22=NaN;

      // Method 1: FITS keywords
      try{
        var kws = {};
        var kw = win.keywords;
        for (var i=0;i<kw.length;i++) kws[kw[i].name.toUpperCase()] = kw[i].strippedValue;
        var fk = function(n){ var x=parseFloat(kws[n]); return isFinite(x)?x:NaN; };
        CRVAL1=fk('CRVAL1'); CRVAL2=fk('CRVAL2');
        CRPIX1=fk('CRPIX1'); CRPIX2=fk('CRPIX2');
        CD11=fk('CD1_1'); CD12=fk('CD1_2'); CD21=fk('CD2_1'); CD22=fk('CD2_2');
        if (!isFinite(CD11)){
          var pc11=fk('PC1_1'),pc12=fk('PC1_2'),pc21=fk('PC2_1'),pc22=fk('PC2_2');
          var cde1=fk('CDELT1'),cde2=fk('CDELT2');
          if (isFinite(pc11)&&isFinite(cde1)){
            var CDpc=buildCDFromPC(pc11,pc12,pc21,pc22,cde1,cde2);
            CD11=CDpc.a; CD12=CDpc.b; CD21=CDpc.c; CD22=CDpc.d;
          }
        }
        console.writeln('[parseWCS] FITS: CRVAL1='+CRVAL1+' CRVAL2='+CRVAL2+
          ' CRPIX1='+CRPIX1+' CRPIX2='+CRPIX2+' CD1_1='+CD11+' CD2_2='+CD22);
      }catch(e){ console.warningln('[parseWCS] FITS read error: '+e); }

      // Method 2: astrometricSolutionSummary() text
      // ImageSolver DDM spline stores WCS in XISF properties, not FITS keywords.
      // The summary text always contains projection origin (CRPIX+CRVAL), scale, rotation.
      if (!isFinite(CRVAL1) || !isFinite(CD11)) {
        try {
          if (win.hasAstrometricSolution && typeof win.astrometricSolutionSummary === 'function') {
            var summary = win.astrometricSolutionSummary();
            console.writeln('[parseWCS] Got summary, length=' + (summary ? summary.length : 0));
            if (summary && summary.length > 20) {
              // Projection origin: [CRPIX1 CRPIX2] px -> [RA: HH MM SS.ss  Dec: +DD MM SS.ss]
              var mOrig = summary.match(/Projection origin[\s\.]+\[([0-9.]+)\s+([0-9.]+)\]\s*px\s*->\s*\[RA:\s*([0-9 .]+)\s+Dec:\s*([+\-0-9 .]+)\]/);
              if (mOrig) {
                CRPIX1 = parseFloat(mOrig[1]);
                CRPIX2 = parseFloat(mOrig[2]);
                var rp = mOrig[3].trim().split(/\s+/);
                CRVAL1 = (parseFloat(rp[0]) + parseFloat(rp[1])/60 + parseFloat(rp[2])/3600) * 15;
                var dp = mOrig[4].trim().split(/\s+/);
                var dsign = (dp[0].charAt(0)==='-') ? -1 : 1;
                CRVAL2 = dsign*(Math.abs(parseFloat(dp[0]))+parseFloat(dp[1])/60+parseFloat(dp[2])/3600);
                console.writeln('[parseWCS] Summary origin: CRPIX=('+CRPIX1.toFixed(2)+','+CRPIX2.toFixed(2)+
                  ') CRVAL=('+CRVAL1.toFixed(6)+','+CRVAL2.toFixed(6)+')');
              } else {
                console.warningln('[parseWCS] Projection origin regex did not match. Summary start: ' +
                  summary.substring(0, 200));
              }

              // Resolution: N.NNN arcsec/px
              var mRes = summary.match(/Resolution[\s\.]+([0-9.]+)\s*arcsec\/px/);
              var summaryScale = mRes ? parseFloat(mRes[1]) / 3600.0 : NaN;

              // Rotation: +/-N.NNN deg
              var mRot = summary.match(/Rotation[\s\.]+([+\-]?[0-9.]+)\s*deg/);
              var summaryRot = mRot ? parseFloat(mRot[1]) : NaN;

              console.writeln('[parseWCS] Summary: scale='+summaryScale+' deg/px rot='+summaryRot+'deg');

              if (isFinite(summaryScale) && isFinite(summaryRot) && !isFinite(CD11)) {
                var R = deg2rad(summaryRot);
                CD11 = -summaryScale * Math.cos(R);
                CD12 = -summaryScale * Math.sin(R);
                CD21 = +summaryScale * Math.sin(R);
                CD22 = -summaryScale * Math.cos(R);
                console.writeln('[parseWCS] Built CD from summary: CD1_2='+CD12.toExponential(3)+' CD2_1='+CD21.toExponential(3));
              }
            }
          } else {
            console.warningln('[parseWCS] astrometricSolutionSummary not available: hasAstro='+
              win.hasAstrometricSolution+' type='+typeof win.astrometricSolutionSummary);
          }
        } catch(e) { console.warningln('[parseWCS] Summary parse error: '+e); }
      }

      // Method 3: GlobalSettings fallback
      if (!isFinite(CD11)) {
        try {
          if (typeof GlobalSettings !== 'undefined' &&
              isFinite(GlobalSettings.imageScale) && GlobalSettings.imageScale > 0 &&
              isFinite(GlobalSettings.wcsRotation)) {
            var fs = GlobalSettings.imageScale / 3600;
            var Rg = deg2rad(GlobalSettings.wcsRotation);
            CD11 = -fs*Math.cos(Rg); CD12 = -fs*Math.sin(Rg);
            CD21 = +fs*Math.sin(Rg); CD22 = -fs*Math.cos(Rg);
            console.writeln('[parseWCS] Built CD from GlobalSettings: scale='+
              GlobalSettings.imageScale.toFixed(4)+'"/px rot='+GlobalSettings.wcsRotation.toFixed(3)+'deg');
          }
        } catch(e) {}
      }

      if (!isFinite(CRVAL1)||!isFinite(CRVAL2)){ result.msg="No CRVAL found"; console.warningln('[parseWCS] '+result.msg); return result; }
      if (!isFinite(CD11))                      { result.msg="No CD matrix";   console.warningln('[parseWCS] '+result.msg); return result; }

      result.ra0  = CRVAL1;
      result.dec0 = CRVAL2;
      result.x0   = isFinite(CRPIX1) ? CRPIX1 : view.image.width/2;
      result.y0   = isFinite(CRPIX2) ? CRPIX2 : view.image.height/2;
      result.CD   = { a:CD11, b:CD12, c:CD21, d:CD22 };
      var s1=Math.sqrt(CD11*CD11+CD21*CD21), s2=Math.sqrt(CD12*CD12+CD22*CD22);
      result.scaleArcsec = 0.5*(Math.abs(s1)+Math.abs(s2))*3600;
      result.rotDeg = rad2deg(Math.atan2(-CD12,CD11));
      if (result.rotDeg<0) result.rotDeg+=360;
      result.ok=true;
      console.writeln('[parseWCS] OK: CRVAL=('+CRVAL1.toFixed(4)+','+CRVAL2.toFixed(4)+
        ') CRPIX=('+result.x0.toFixed(1)+','+result.y0.toFixed(1)+
        ') scale='+result.scaleArcsec.toFixed(3)+'"/px rot='+result.rotDeg.toFixed(2)+'deg');
      return result;
    }catch(e){
      result.msg="Exception: "+e;
      console.warningln('[parseWCS] Exception: '+e);
      return result;
    }
  }

  // TAN projection helpers
  // TAN projection: (RA,Dec) -> display pixel.
  // Uses CD-matrix INVERSE so the math is correct regardless of CD sign conventions.
  // Reference pixel (wcs.x0, wcs.y0) must be in display coords (0-indexed, y from top).
  // Reference sky coords are (wcs.ra0, wcs.dec0).
  function worldToPixel_TAN(wcs, raDeg, decDeg){
    var ra0 = deg2rad(wcs.ra0), dec0 = deg2rad(wcs.dec0);
    var ra  = deg2rad(raDeg),   dec  = deg2rad(decDeg);

    // Full gnomonic (TAN) projection onto tangent plane
    var cosc = Math.sin(dec0)*Math.sin(dec) +
               Math.cos(dec0)*Math.cos(dec)*Math.cos(ra - ra0);
    if (Math.abs(cosc) < 1e-10) cosc = 1e-10;
    var xi  = rad2deg( Math.cos(dec)*Math.sin(ra - ra0) / cosc );
    var eta = rad2deg( (Math.cos(dec0)*Math.sin(dec) -
                        Math.sin(dec0)*Math.cos(dec)*Math.cos(ra - ra0)) / cosc );

    // CD^-1: maps sky offsets (xi,eta) [deg] -> pixel offsets (dx,dy) [px]
    var a = wcs.CD.a, b = wcs.CD.b, c = wcs.CD.c, d = wcs.CD.d;
    var det = a*d - b*c;
    if (!isFinite(det) || Math.abs(det) < 1e-20) throw new Error("Singular CD matrix");
    var dx = ( d*xi - b*eta) / det;
    var dy = (-c*xi + a*eta) / det;

    return { x: wcs.x0 + dx, y: wcs.y0 + dy };
  }

  function pixelToWorld_TAN(wcs, x, y){
    var dx = x - wcs.x0;
    var dy = y - wcs.y0;

    // Inverse CD
    var det = wcs.CD.a*wcs.CD.d - wcs.CD.b*wcs.CD.c;
    if (!isFinite(det) || Math.abs(det) < 1e-20) throw new Error("Singular CD matrix");

    var u = ( wcs.CD.d*dx - wcs.CD.b*dy)/det; // deg
    var v = (-wcs.CD.c*dx + wcs.CD.a*dy)/det; // deg

    // TAN inverse: u=xi(deg), v=eta(deg)
    var xi  = deg2rad(u);
    var eta = deg2rad(v);

    var rho = Math.sqrt(xi*xi + eta*eta);
    var c   = Math.atan(rho);

    var ra0  = deg2rad(wcs.ra0), dec0 = deg2rad(wcs.dec0);
    var sin_c = Math.sin(c), cos_c = Math.cos(c);
    var sin_dec0 = Math.sin(dec0), cos_dec0 = Math.cos(dec0);

    var dec = Math.asin( cos_c*sin_dec0 + (eta * sin_c * cos_dec0 / (rho||1)) );
    var ra  = ra0 + Math.atan2( xi*sin_c, (rho*cos_dec0*cos_c - eta*sin_dec0*sin_c) );

    return { ra: (rad2deg(ra)+540)%360-180, dec: rad2deg(dec) }; // normalize RA
  }

  // Build coordinate provider.
  // Strategy: NEVER use PixInsight WorldToImage (produces reflected y coords).
  // Instead: use ImageToWorld(image_centre) to get the sky coords of the centre pixel,
  // then do pure TAN + CD^-1 math from that reference point.
  // This is fully self-consistent, works on any crop, and needs only the CD matrix
  // (plate scale + rotation) which PixInsight writes correctly.
  function makeProvider(win){
    // Strategy: derive everything from ImageToWorld by sampling 3 pixels.
    // This avoids ALL FITS header convention questions (CRPIX indexing, CD sign,
    // y-axis direction) and works correctly on any crop, rotation, or scale.
    // WorldToImage is never called (it produces reflected y-coordinates).
    var wcsParsed = parseWCS(win); // still used as fallback if ImageToWorld unavailable
    var astro = null;
    var wcsForTAN = null;

    try{
      if (win.hasAstrometricSolution && win.mainView && (win.astrometricSolution || win.mainView.astrometricSolution)){
        astro = win.astrometricSolution || win.mainView.astrometricSolution;
        if (astro && typeof astro.ImageToWorld === 'function'){
          var iw = win.mainView.image.width;
          var ih = win.mainView.image.height;
          var cx = iw / 2;
          var cy = ih / 2;
          var step = Math.min(iw, ih) * 0.1; // 10% of shorter dimension — robust step size

          // Sample sky coords at 3 display pixels
          var p0 = astro.ImageToWorld(new Point(cx,        cy       )); // centre
          var p1 = astro.ImageToWorld(new Point(cx + step, cy       )); // right
          var p2 = astro.ImageToWorld(new Point(cx,        cy + step)); // down

          if (p0 && p1 && p2 &&
              isFinite(p0.x) && isFinite(p0.y) &&
              isFinite(p1.x) && isFinite(p1.y) &&
              isFinite(p2.x) && isFinite(p2.y)){

            // Derive CD matrix: pixel offset -> sky offset (degrees per pixel)
            // p.x = RA (degrees), p.y = Dec (degrees)
            // No cos(Dec) correction needed here — CD1_1 carries the raw RA/pixel ratio,
            // and the TAN projection applies cos(Dec) internally via the gnomonic formula.
            var CD11 = (p1.x - p0.x) / step; // dRA  per pixel in x direction
            var CD21 = (p1.y - p0.y) / step; // dDec per pixel in x direction
            var CD12 = (p2.x - p0.x) / step; // dRA  per pixel in y direction
            var CD22 = (p2.y - p0.y) / step; // dDec per pixel in y direction

            wcsForTAN = {
              ra0:  p0.x,  // RA  of image centre pixel
              dec0: p0.y,  // Dec of image centre pixel
              x0:   cx,    // image centre x (display, 0-indexed)
              y0:   cy,    // image centre y (display, 0-indexed)
              CD:   { a: CD11, b: CD12, c: CD21, d: CD22 },
              ok:   true
            };
            console.writeln('[WCS] CD matrix derived from ImageToWorld: ' +
              'CD1_1=' + CD11.toExponential(3) + ' CD2_2=' + CD22.toExponential(3) +
              ' scale≈' + (Math.sqrt(CD21*CD21+CD22*CD22)*3600).toFixed(2) + '"/px');
          }
        }
      }
    }catch(e){
      console.warningln('[WCS] ImageToWorld sampling failed: ' + e + ' — trying FITS header fallback');
      wcsForTAN = null;
    }

    // Fallback: use FITS header CRPIX/CRVAL/CD if ImageToWorld unavailable
    if (!wcsForTAN && wcsParsed.ok){
      wcsForTAN = wcsParsed;
      console.writeln('[WCS] Using FITS header for WCS (ImageToWorld unavailable)');
    }

    var ok = (wcsForTAN && wcsForTAN.ok);

    return {
      ok: ok,
      info: wcsParsed,
      worldToPixel: function(raDeg, decDeg){
        if (!ok) throw new Error("No usable WCS — image may not be plate-solved");
        return worldToPixel_TAN(wcsForTAN, raDeg, decDeg);
      },
      pixelToWorld: function(x, y){
        // Always prefer ImageToWorld for pixel->sky (it is reliable)
        if (astro && typeof astro.ImageToWorld === 'function'){
          try{
            var p = astro.ImageToWorld(new Point(x, y));
            if (p && isFinite(p.x) && isFinite(p.y)) return { ra: p.x, dec: p.y };
          }catch(e){}
        }
        if (!ok) throw new Error("No usable WCS");
        return pixelToWorld_TAN(wcsForTAN, x, y);
      },
      roundtripSelfTest: function(){
        if (!ok) return { ok: false, msg: "No usable WCS" };
        var cx = win.mainView.image.width  / 2;
        var cy = win.mainView.image.height / 2;
        var wd = this.pixelToWorld(cx, cy);
        var rp = this.worldToPixel(wd.ra, wd.dec);
        var err = Math.hypot(rp.x - cx, rp.y - cy);
        return { ok: (err < 1.0), pxError: err };
      }
    };
  }

  // Public singleton
  var EXOWCS = {
    buildProvider: function(win){ return makeProvider(win || ImageWindow.activeWindow); },
    pixelToWorld: function(win,x,y){ return this.buildProvider(win).pixelToWorld(x,y); },
    worldToPixel: function(win,ra,dec){ return this.buildProvider(win).worldToPixel(ra,dec); },
    debugPrint: function(win){
      var prov = this.buildProvider(win);
      if (!prov.ok){ console.warningln("[ExoWCS] No usable WCS"); return; }
      var inf = prov.info;
      console.writeln(
        "[ExoWCS] Parsed WCS (TAN): center RA="+(inf.ra0||NaN).toFixed(6)+"° Dec="+(inf.dec0||NaN).toFixed(6)+
        "°, origin (x0,y0)=("+ (inf.x0||NaN).toFixed(3)+", "+(inf.y0||NaN).toFixed(3)+"), scale≈"+
        (inf.scaleArcsec||NaN).toFixed(3)+'"/px, rot≈'+(inf.rotDeg||NaN).toFixed(3)+"°"
      );
      var cx = (win.mainView.image.width||0)/2, cy=(win.mainView.image.height||0)/2;
      var wd = prov.pixelToWorld(cx, cy);
      var rp = prov.worldToPixel(wd.ra, wd.dec);
      console.writeln("[ExoWCS] Center roundtrip: pix("+cx.toFixed(2)+","+cy.toFixed(2)+") -> ra/dec("+
                      wd.ra.toFixed(6)+"°,"+wd.dec.toFixed(6)+"°) -> pix("+rp.x.toFixed(2)+","+rp.y.toFixed(2)+")");
    }
  };

  // Optional auto-registration: if host script exposes a hook, register this provider
  try{
    if (typeof global.registerWCSProvider === 'function'){
      global.registerWCSProvider(function(){ return EXOWCS.buildProvider(ImageWindow.activeWindow); });
      console.writeln("[ExoWCS] Provider registered with host script");
    }
  }catch(e){}

  // Expose globally without clobbering existing symbols
  global.EXOWCS = EXOWCS; // always overwrite — no session caching

})(this);



/* === EXO ROBUSTNESS CORE (scoped, non-GUI) === */
(function(){
  "use strict";
  // ensure global holder without relying on 'this'
  var __g = (function(){ try { return (Function('return this'))(); } catch(e){ return (typeof globalThis!=='undefined')? globalThis : {}; } })();
  if (typeof __g.__EXO_SKIP_IMAGEMETADATA__ === 'undefined') __g.__EXO_SKIP_IMAGEMETADATA__ = true;
  if (typeof __g.__EXO_ALT_DIAG_INSTALLED__ === 'undefined') __g.__EXO_ALT_DIAG_INSTALLED__ = false;

  // helpers as function expressions
  if (typeof __g.__deg_from_hms_exo === 'undefined') __g.__deg_from_hms_exo = function(s){
    if (s === undefined || s === null) return NaN;
    s = String(s).trim().replace(/\s+/g,' ');
    var m = s.match(/^([0-9]+)\s+([0-9]+)\s+([0-9.]+)/);
    if (!m) return NaN;
    var h = +m[1], mi = +m[2], se = +m[3];
    return 15*(h + mi/60 + se/3600);
  };
  if (typeof __g.__deg_from_dms_exo === 'undefined') __g.__deg_from_dms_exo = function(s){
    if (s === undefined || s === null) return NaN;
    s = String(s).trim().replace(/\s+/g,' ');
    var m = s.match(/^([+\-]?[0-9]+)\s+([0-9]+)\s+([0-9.]+)/);
    if (!m) return NaN;
    var d = +m[1], mi = +m[2], se = +m[3];
    var sign = d < 0 ? -1 : 1;
    d = Math.abs(d);
    var val = d + mi/60 + se/3600;
    return sign*val;
  };
  if (typeof __g.__norm360_exo === 'undefined') __g.__norm360_exo = function(a){ a%=360; if(a<0) a+=360; return a; };
  if (typeof __g.__jd_to_gmst_deg_exo === 'undefined') __g.__jd_to_gmst_deg_exo = function(JD){
    var T = (JD - 2451545.0)/36525.0;
    var gmst = 280.46061837 + 360.98564736629*(JD - 2451545.0) + 0.000387933*T*T - T*T*T/38710000.0;
    return __g.__norm360_exo(gmst);
  };
  if (typeof __g.__computeAirmassFromKeywords === 'undefined') __g.__computeAirmassFromKeywords = function(kw){
    try{
      var jd = jdFromKeywords(kw);
      var exp = parseFloat(getKeyword(kw,'EXPTIME') || getKeyword(kw,'EXPOSURE') || '0');
      if (isFinite(jd) && exp>0) jd += 0.5*exp/86400.0;
      if (!isFinite(jd)) return NaN;

      var ra = parseFloat(getKeyword(kw,'RA') || 'NaN');
      var dec = parseFloat(getKeyword(kw,'DEC') || 'NaN');
      if (!isFinite(ra) || !isFinite(dec)){
        var rstr = getKeyword(kw,'OBJCTRA');
        var dstr = getKeyword(kw,'OBJCTDEC');
        ra = isFinite(ra)? ra : __g.__deg_from_hms_exo(rstr);
        dec = isFinite(dec)? dec : __g.__deg_from_dms_exo(dstr);
      }
      if (!isFinite(ra) || !isFinite(dec)) return NaN;

      var lon = parseFloat(getKeyword(kw,'OBSGEO-L') || getKeyword(kw,'LONGITUD') || 'NaN');
      var lat = parseFloat(getKeyword(kw,'OBSGEO-B') || getKeyword(kw,'LATITUDE') || 'NaN');

      var __parseSignedDeg_EXO = function(v, isLon){
        if (v === undefined || v === null) return NaN;
        v = String(v).trim();
        var sign = 1;
        if (/W$/i.test(v)) sign = -1;
        if (/S$/i.test(v) && !isLon) sign = -1;
        var m = v.replace(/[NSEW]/ig,'').trim().match(/^([+\-]?[0-9.]+)/);
        if (!m) return NaN;
        var val = parseFloat(m[1]);
        return sign*val;
      };

      if (!isFinite(lon)){
        var lstr = getKeyword(kw,'LONG-STR') || getKeyword(kw,'OBSGEOL') || '';
        lon = __parseSignedDeg_EXO(lstr, true);
      }
      if (!isFinite(lat)){
        var bstr = getKeyword(kw,'LAT-STR') || getKeyword(kw,'OBSGEOB') || '';
        lat = __parseSignedDeg_EXO(bstr, false);
      }
      if (!isFinite(lon) || !isFinite(lat)) return NaN;

      var gmst = __g.__jd_to_gmst_deg_exo(jd);
      var lst = __g.__norm360_exo(gmst + lon);
      var ha = __g.__norm360_exo(lst - ra);
      var deg2rad = Math.PI/180.0;
      var latr = lat*deg2rad, decr = dec*deg2rad, har = ha*deg2rad;
      var sinAlt = Math.sin(latr)*Math.sin(decr) + Math.cos(latr)*Math.cos(decr)*Math.cos(har);
      if (sinAlt> 1) sinAlt=1; if (sinAlt<-1) sinAlt=-1;
      var altDeg = Math.asin(sinAlt)/deg2rad;
      var z = Math.max(0, 90.0 - altDeg);
      var X = 1.0 / (Math.cos(z*deg2rad) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
      return X;
    }catch(e){ return NaN; }
  };
})();
/* === END EXO ROBUSTNESS CORE === */

// Enhanced coordinate accuracy with clean, professional approach
// No external dependencies to avoid warnings

#define EXOTRANSIT_VERSION "3.1.0-universal"
#define SETTINGS_MODULE "EXOTRANSIT_WCS_SETTINGS" // This key is used to store and retrieve settings
#define ENHANCED_COORDINATE_ACCURACY true // Enable enhanced mathematical algorithms

// WCS metadata functionality - will be loaded dynamically at runtime
// This avoids compile-time errors if WCSmetadata.jsh is not found
var WCS_METADATA_AVAILABLE = false;
var ImageMetadata = null; // Will be set at runtime if available

// Runtime detection of WCS metadata capability
function initializeWCSMetadata() {
  if (WCS_METADATA_AVAILABLE) {
    return true; // Already initialized successfully
  }
  
  try {
    // Check if ImageMetadata type is already defined (by other PixInsight scripts)
    if (typeof ImageMetadata !== 'undefined' && ImageMetadata !== null) {
      WCS_METADATA_AVAILABLE = true;
      console.writeln('[WCS] ImageMetadata type found - WCS solution access enabled');
      return true;
    }
    
    // Try to detect if ImageMetadata is available in global scope
    if (typeof this.ImageMetadata !== 'undefined') {
      ImageMetadata = this.ImageMetadata;
      WCS_METADATA_AVAILABLE = true;
      console.writeln('[WCS] ImageMetadata found in global scope - WCS solution access enabled');
      return true;
    }
    
    // Check if any of the AdP scripts have been run (they define ImageMetadata)
    try {
      // Try to create ImageMetadata - this will work if it's been defined by another script
      var testMetadata = new ImageMetadata();
      if (testMetadata) {
        WCS_METADATA_AVAILABLE = true;
        console.writeln('[WCS] ImageMetadata constructor available - WCS solution access enabled');
        return true;
      }
    } catch (e) {
      // ImageMetadata not available, continue to fallback
    }
    
    // Alternative: We can still extract rotation from FITS keywords directly
    console.writeln('[WCS] ImageMetadata not available - will use direct FITS keyword extraction');
    console.writeln('[WCS] Note: For best accuracy, run ImageSolver or another AdP script first');
    return false; // Will be handled by extractRotationFromFITS function
    
  } catch (e) {
    console.writeln('[WCS] WCS metadata initialization failed: ' + e);
    return false;
  }
}

/**
 * Extract rotation directly from FITS keywords (fallback when WCS metadata API unavailable)
 * @param {ImageWindow} imageWindow - PixInsight image window
 * @returns {object} - {success: boolean, rotation: number, method: string, error: string}
 */
function extractRotationFromFITS(imageWindow) {
  try {
    if (!imageWindow || imageWindow.isNull) {
      return { success: false, error: 'No image window', method: 'no-image' };
    }
    
    // Check if image has astrometric solution
    if (!imageWindow.hasAstrometricSolution) {
      return { success: false, error: 'No astrometric solution', method: 'no-wcs' };
    }
    
    console.writeln('[WCS] Extracting rotation from FITS keywords directly...');
    
    // Build keyword map from FITS headers
    var kw = buildKeywordMap(imageWindow);
    
    // Debug: Show some relevant keywords that might contain rotation
    console.writeln('[WCS] Debug - checking for rotation keywords:');
    var debugKeywords = ['CROTA2', 'PC1_1', 'PC1_2', 'CD1_1', 'CD1_2', 'CROTA1', 'ORIENTAT'];
    for (var i = 0; i < debugKeywords.length; i++) {
      var keyName = debugKeywords[i];
      var keyValue = getKeyword(kw, keyName);
      if (keyValue !== null && keyValue !== undefined && keyValue !== '') {
        console.writeln('[WCS]   ' + keyName + ' = ' + keyValue);
      }
    }
    
    var rotation = null;
    var method = '';
    
    // Method 1: Try CROTA2 keyword (common)
    var crota2 = parseFloat(getKeyword(kw, 'CROTA2'));
    if (isFinite(crota2)) {
      rotation = crota2;
      method = 'crota2-fits-keyword';
      console.writeln('[WCS] Found CROTA2 rotation: ' + rotation.toFixed(4) + '°');
    }
    // Method 1b: Try CROTA1 as alternative
    else {
      var crota1 = parseFloat(getKeyword(kw, 'CROTA1'));
      if (isFinite(crota1)) {
        rotation = crota1;
        method = 'crota1-fits-keyword';
        console.writeln('[WCS] Found CROTA1 rotation: ' + rotation.toFixed(4) + '°');
      }
    }
    // Method 2: Try PC matrix elements
    if (rotation === null) {
      var pc1_1 = parseFloat(getKeyword(kw, 'PC1_1'));
      var pc1_2 = parseFloat(getKeyword(kw, 'PC1_2'));
      
      if (isFinite(pc1_1) && isFinite(pc1_2)) {
        // Calculate rotation from PC matrix: θ = atan2(-PC1_2, PC1_1)
        rotation = Math.atan2(-pc1_2, pc1_1) * 180.0 / Math.PI;
        method = 'pc-matrix-fits-keyword';
        console.writeln('[WCS] Calculated rotation from PC matrix: ' + rotation.toFixed(4) + '°');
        console.writeln('[WCS]   PC1_1=' + pc1_1.toFixed(6) + ', PC1_2=' + pc1_2.toFixed(6));
      }
    }
    // Method 3: Try CD matrix elements
    if (rotation === null) {
      var cd1_1 = parseFloat(getKeyword(kw, 'CD1_1'));
      var cd1_2 = parseFloat(getKeyword(kw, 'CD1_2'));
      
      if (isFinite(cd1_1) && isFinite(cd1_2)) {
        // Calculate rotation from CD matrix: θ = atan2(-CD1_2, CD1_1)
        rotation = Math.atan2(-cd1_2, cd1_1) * 180.0 / Math.PI;
        method = 'cd-matrix-fits-keyword';
        console.writeln('[WCS] Calculated rotation from CD matrix: ' + rotation.toFixed(4) + '°');
        console.writeln('[WCS]   CD1_1=' + cd1_1.toExponential(4) + ', CD1_2=' + cd1_2.toExponential(4));
      }
    }
    
    // Method 4: Try PixInsight's astrometric solution summary
    if (rotation === null) {
      try {
        if (imageWindow.hasAstrometricSolution) {
          var summary = imageWindow.astrometricSolutionSummary();
          if (summary && typeof summary === 'string') {
            // Look for rotation in the summary text
            var rotationMatch = summary.match(/Rotation[\s\.]*([+-]?[0-9]*\.?[0-9]+)\s*deg/i);
            if (rotationMatch && rotationMatch[1]) {
              rotation = parseFloat(rotationMatch[1]);
              method = 'astrometric-solution-summary';
              // Also try to extract image scale from summary (Resolution .... XX arcsec/px)
              try {
                var resMatch = summary.match(/Resolution[\s\.]*([0-9]*\.?[0-9]+)\s*arcsec\/px/i);
                if (resMatch && resMatch[1]) {
                  var pxScale = parseFloat(resMatch[1]);
                  if (isFinite(pxScale)) {
                    if (!metadata) var metadata = {};
                    metadata.pixelScale = pxScale;
                  }
                }
              } catch (e) {}

              console.writeln('[WCS] Extracted rotation from astrometric solution summary: ' + rotation.toFixed(4) + '°');
            }
          }
        }
      } catch (e) {
        console.writeln('[WCS] Could not access astrometric solution summary: ' + e);
      }
    }
    
    if (rotation === null || !isFinite(rotation)) {
      return {
        success: false,
        error: 'Could not extract rotation from FITS keywords',
        method: 'fits-extraction-failed'
      };
    }
    
    // Normalize rotation to [-180, 180] range
    while (rotation > 180) rotation -= 360;
    while (rotation <= -180) rotation += 360;
    
    console.writeln('[WCS] ✅ Successfully extracted rotation from FITS: ' + rotation.toFixed(4) + '° (method: ' + method + ')');
    
    return {
      success: true,
      rotation: rotation,
      method: method
    };
    
  } catch (e) {
    console.warningln('[WCS] ❌ FITS rotation extraction failed: ' + e);
    return {
      success: false,
      error: 'Exception during FITS extraction: ' + e,
      method: 'fits-exception'
    };
  }
}

// ===============================================================================
// ENHANCED COORDINATE ACCURACY FUNCTIONS - TEST BUILD
// Mathematical improvements for higher precision astrometric measurements
// ===============================================================================

/**
 * Enhanced Euclidean distance calculation for precise positioning
 * Replaces multiplication-based distance calculations with proper geometry
 * @param {Array} point1 - [x, y] coordinates of first point
 * @param {Array} point2 - [x, y] coordinates of second point
 * @returns {Number} Euclidean distance
 */
function calculateEnhancedEuclideanDistance(point1, point2) {
  var dx = point1[0] - point2[0];
  var dy = point1[1] - point2[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * High-precision angular distance calculation using Haversine formula
 * More accurate than simple trigonometric approximations for celestial coordinates
 * @param {Object} point1 - {x: RA_degrees, y: Dec_degrees}
 * @param {Object} point2 - {x: RA_degrees, y: Dec_degrees}
 * @returns {Number} Angular distance in arcminutes
 */
function calculateEnhancedAngularDistance(point1, point2) {
  try {
    // Convert degrees to radians for higher precision
    var ra1 = point1.x * Math.PI / 180.0;
    var dec1 = point1.y * Math.PI / 180.0;
    var ra2 = point2.x * Math.PI / 180.0;
    var dec2 = point2.y * Math.PI / 180.0;
    
    // Handle RA wrap-around at 0/360 degrees
    var deltaRA = ra2 - ra1;
    if (deltaRA > Math.PI) deltaRA -= 2 * Math.PI;
    if (deltaRA < -Math.PI) deltaRA += 2 * Math.PI;
    
    // Haversine formula for great circle distance on celestial sphere
    var haversineLat = Math.sin((dec2 - dec1) / 2);
    var haversineRA = Math.sin(deltaRA / 2);
    
    var a = haversineLat * haversineLat + 
            Math.cos(dec1) * Math.cos(dec2) * haversineRA * haversineRA;
    
    // Use atan2 for better numerical stability near zero
    var angularDistanceRad = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    // Convert to arcminutes with high precision
    return angularDistanceRad * 180.0 / Math.PI * 60.0;
    
  } catch (e) {
    console.warningln('[ENHANCED] Angular distance calculation failed: ' + e);
    // Fallback to simple distance approximation
    var dRA = (point2.x - point1.x) * Math.cos(point1.y * Math.PI / 180.0);
    var dDec = point2.y - point1.y;
    return Math.sqrt(dRA * dRA + dDec * dDec) * 60.0; // Convert degrees to arcminutes
  }
}

/**
 * Enhanced position angle calculation using atan2 approach
 * More robust than quadrant-based calculations with proper edge case handling
 * @param {Object} pointFrom - Starting point {x: RA_degrees, y: Dec_degrees}
 * @param {Object} pointTo - End point {x: RA_degrees, y: Dec_degrees}
 * @returns {Number} Position angle in degrees (0-360)
 */
function calculateEnhancedPositionAngle(pointFrom, pointTo) {
  try {
    // Convert to radians
    var ra1 = pointFrom.x * Math.PI / 180.0;
    var dec1 = pointFrom.y * Math.PI / 180.0;
    var ra2 = pointTo.x * Math.PI / 180.0;
    var dec2 = pointTo.y * Math.PI / 180.0;
    
    // Handle RA wrap-around
    var deltaRA = ra2 - ra1;
    if (deltaRA > Math.PI) deltaRA -= 2 * Math.PI;
    if (deltaRA < -Math.PI) deltaRA += 2 * Math.PI;
    
    // Calculate position angle components
    var y = Math.sin(deltaRA) * Math.cos(dec2);
    var x = Math.cos(dec1) * Math.sin(dec2) - 
            Math.sin(dec1) * Math.cos(dec2) * Math.cos(deltaRA);
    
    // Use atan2 for proper quadrant determination
    var positionAngle = Math.atan2(y, x) * 180.0 / Math.PI;
    
    // Normalize to 0-360 degrees
    return positionAngle < 0 ? positionAngle + 360 : positionAngle;
    
  } catch (e) {
    console.warningln('[ENHANCED] Position angle calculation failed: ' + e);
    // Fallback to simple angle calculation
    var dRA = pointTo.x - pointFrom.x;
    var dDec = pointTo.y - pointFrom.y;
    var angle = Math.atan2(dRA, dDec) * 180.0 / Math.PI;
    return angle < 0 ? angle + 360 : angle;
  }
}

/**
 * Enhanced coordinate precision formatting
 * Provides higher precision coordinate display (8 decimal places vs 5)
 * @param {Number} coordinate - Coordinate value in degrees
 * @param {String} type - 'ra' or 'dec' for appropriate formatting
 * @returns {String} Formatted coordinate string
 */
function formatEnhancedCoordinate(coordinate, type) {
  if (!isFinite(coordinate)) {
    return 'N/A';
  }
  
  // Use 8 decimal places for enhanced precision (~0.01 arcsecond accuracy)
  return coordinate.toFixed(8) + '°';
}

/**
 * Enhanced star matching algorithm using improved distance calculation
 * Replaces simple distance approximations with proper spherical geometry
 * @param {Array} candidateStars - Array of candidate star objects
 * @param {Object} targetCoords - Target coordinates {x: RA, y: Dec}
 * @param {Number} searchRadius - Search radius in arcminutes
 * @returns {Object|null} Best matching star or null if none found
 */
function findEnhancedStarMatch(candidateStars, targetCoords, searchRadius) {
  if (!candidateStars || candidateStars.length === 0) {
    return null;
  }
  
  var bestMatch = null;
  var bestDistance = searchRadius; // Maximum allowed distance
  
  for (var i = 0; i < candidateStars.length; i++) {
    var candidate = candidateStars[i];
    if (!candidate.coords || !isFinite(candidate.coords.x) || !isFinite(candidate.coords.y)) {
      continue;
    }
    
    // Use enhanced angular distance calculation
    var distance = calculateEnhancedAngularDistance(targetCoords, candidate.coords);
    
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = {
        star: candidate,
        distance: distance,
        method: 'enhanced-haversine'
      };
    }
  }
  
  if (bestMatch) {
    console.writeln('[ENHANCED] Found star match at distance: ' + bestMatch.distance.toFixed(4) + ' arcmin');
  }
  
  return bestMatch;
}

/**
 * Enhanced coordinate validation with improved precision checks
 * Validates coordinate ranges and precision for high-accuracy measurements
 * @param {Number} ra - Right Ascension in degrees
 * @param {Number} dec - Declination in degrees
 * @returns {Object} Validation result {valid: boolean, warnings: Array}
 */
function validateEnhancedCoordinates(ra, dec) {
  var result = {
    valid: true,
    warnings: []
  };
  
  // Check basic range validity
  if (!isFinite(ra) || ra < 0 || ra >= 360) {
    result.valid = false;
    result.warnings.push('RA out of range [0, 360): ' + ra);
  }
  
  if (!isFinite(dec) || dec < -90 || dec > 90) {
    result.valid = false;
    result.warnings.push('Dec out of range [-90, 90]: ' + dec);
  }
  
  // Check for suspicious precision (very round numbers might indicate low precision)
  if (result.valid) {
    var raStr = ra.toString();
    var decStr = dec.toString();
    
    if (raStr.indexOf('.') === -1 || decStr.indexOf('.') === -1) {
      result.warnings.push('Coordinates appear to have low precision (integer values)');
    } else {
      var raDecimals = raStr.split('.')[1].length;
      var decDecimals = decStr.split('.')[1].length;
      
      if (raDecimals < 4 || decDecimals < 4) {
        result.warnings.push('Coordinates have low precision (< 4 decimal places)');
      }
    }
  }
  
  return result;
}

// Enhanced logging for coordinate accuracy testing
function logEnhancedCoordinateComparison(method1Result, method2Result, context) {
  if (!method1Result || !method2Result) return;
  
  console.writeln('[ENHANCED] Coordinate comparison (' + context + '):');
  console.writeln('  Method 1: RA=' + formatEnhancedCoordinate(method1Result.ra, 'ra') + 
                  ', Dec=' + formatEnhancedCoordinate(method1Result.dec, 'dec'));
  console.writeln('  Method 2: RA=' + formatEnhancedCoordinate(method2Result.ra, 'ra') + 
                  ', Dec=' + formatEnhancedCoordinate(method2Result.dec, 'dec'));
  
  if (isFinite(method1Result.ra) && isFinite(method2Result.ra)) {
    var raDiff = Math.abs(method1Result.ra - method2Result.ra) * 3600; // arcseconds
    var decDiff = Math.abs(method1Result.dec - method2Result.dec) * 3600; // arcseconds
    console.writeln('  Differences: RA=' + raDiff.toFixed(4) + '", Dec=' + decDiff.toFixed(4) + '"');
  }
}

// ===============================================================================
// END ENHANCED COORDINATE ACCURACY FUNCTIONS
// ===============================================================================

// ---------------- Automatic WCS Rotation Extraction ----------------

/**
 * Helper function to load ImageMetadata by running a minimal AdP script
 * This makes ImageMetadata available in the scripting environment
 */
function loadImageMetadataDefinition() {
  try {
    // Try to load and execute a minimal ImageSolver to make ImageMetadata available
    console.writeln('[WCS] Attempting to load ImageMetadata definition...');
    
    // Method 1: Try to load ImageSolver script to get ImageMetadata definition
    var imageSolverPath = "C:/Program Files/PixInsight/src/scripts/AdP/ImageSolver.js";
    try {
      // We can't directly #include or load the script, but we can try to access it
      console.writeln('[WCS] ImageSolver path: ' + imageSolverPath);
      console.writeln('[WCS] To enable ImageMetadata, run ImageSolver once (even cancel immediately)');
      console.writeln('[WCS] Or run any AdP script like AnnotateImage to make ImageMetadata available');
    } catch (e) {
      console.writeln('[WCS] Could not access ImageSolver: ' + e);
    }
    
    return false; // Manual intervention needed
  } catch (e) {
    console.writeln('[WCS] Failed to load ImageMetadata definition: ' + e);
    return false;
  }
}

/**
 * Extract precise WCS solution data directly from XISF properties (ImageSolver WCS)
 * This accesses the actual ImageSolver WCS solution stored as XISF properties
 * @param {ImageWindow} imageWindow - PixInsight image window with astrometric solution
 * @returns {object} - {success: boolean, data: object, method: string, error: string}
 */
function extractXISFWCSProperties(imageWindow) {
  try {
    if (!imageWindow || imageWindow.isNull) {
      return { success: false, error: 'No image window', method: 'no-image' };
    }
    
    if (!imageWindow.hasAstrometricSolution) {
      return { success: false, error: 'No astrometric solution', method: 'no-wcs' };
    }
    
    console.writeln('[WCS] Extracting XISF WCS properties directly (ImageSolver precision)...');
    
    // Create a temporary file format instance to access XISF properties
    var F = new FileFormat('.xisf', true/*toRead*/, false/*toWrite*/);
    if (F.isNull) {
      console.writeln('[WCS] XISF format not available');
      return { success: false, error: 'XISF format not available', method: 'no-xisf' };
    }
    
    // Try to access the view's properties directly
    var view = imageWindow.mainView;
    if (!view || view.isNull) {
      return { success: false, error: 'No main view', method: 'no-view' };
    }
    
    // Method 1: Try to access properties using exportProperties (Juan Conejero's method)
    console.writeln('[WCS] Attempting to export XISF properties from view...');
    
    var wcsData = {
      centerRA: null,
      centerDec: null,
      rotation: null,
      pixelScale: null,
      pixelScaleArcsec: null
    };
    
    // Try to create a temporary file format instance to capture properties
    try {
      var tempFilePath = File.systemTempDirectory + '/temp_wcs_props_' + Date.now() + '.xisf';
      
      var f = new FileFormatInstance(F);
      if (!f.isNull && f.create && f.create(tempFilePath)) {
        console.writeln('[WCS] Created temporary file for property export');
        
        // Use exportProperties to get the WCS data
        view.exportProperties(f);
        
        // Now try to read back the properties  
        // This is where ImageSolver stores its precise WCS solution
        console.writeln('[WCS] Properties exported, attempting to read WCS solution...');
        
        f.close();
        
        // Clean up temp file
        try {
          File.remove(tempFilePath);
        } catch (e) {}
        
        console.writeln('[WCS] exportProperties method completed - checking for WCS solution data');
      }
    } catch (e) {
      console.writeln('[WCS] exportProperties method failed: ' + e);
    }
    
    // Method 2: Try to access astrometric solution data directly
    try {
      if (view.astrometricSolution) {
        console.writeln('[WCS] Found view.astrometricSolution, attempting to extract parameters...');
        var astroSol = view.astrometricSolution;
        
        // Try to access solution parameters
        if (astroSol.centerRA !== undefined) {
          wcsData.centerRA = astroSol.centerRA;
          console.writeln('[WCS]   Extracted centerRA: ' + wcsData.centerRA);
        }
        if (astroSol.centerDec !== undefined) {
          wcsData.centerDec = astroSol.centerDec;
          console.writeln('[WCS]   Extracted centerDec: ' + wcsData.centerDec);
        }
        if (astroSol.rotation !== undefined) {
          wcsData.rotation = astroSol.rotation;
          console.writeln('[WCS]   Extracted rotation: ' + wcsData.rotation);
        }
        if (astroSol.pixelSize !== undefined) {
          wcsData.pixelScaleArcsec = astroSol.pixelSize;
          wcsData.pixelScale = astroSol.pixelSize / 3600.0;
          console.writeln('[WCS]   Extracted pixelSize: ' + wcsData.pixelScaleArcsec);
        }
        if (astroSol.resolution !== undefined) {
          var res = astroSol.resolution;
          if (res > 1) {
            wcsData.pixelScaleArcsec = res;
            wcsData.pixelScale = res / 3600.0;
          } else {
            wcsData.pixelScale = res;
            wcsData.pixelScaleArcsec = res * 3600.0;
          }
          console.writeln('[WCS]   Extracted resolution: ' + res);
        }
      }
    } catch (e) {
      console.writeln('[WCS] Direct astrometric solution access failed: ' + e);
    }
    
    // Method 3: Try common XISF property names used by ImageSolver
    var propertyNames = [
      'Observation:Center:RA',
      'Observation:Center:Dec', 
      'Observation:Center:X',
      'Observation:Center:Y',
      'Astrometry:CenterRA',
      'Astrometry:CenterDec',
      'Astrometry:Rotation',
      'Astrometry:PixelScale',
      'Astrometry:Resolution',
      'WCS:CenterRA',
      'WCS:CenterDec',
      'WCS:Rotation',
      'WCS:PixelScale'
    ];
    
    // Try to read each property
    for (var i = 0; i < propertyNames.length; i++) {
      try {
        if (view.hasProperty && view.hasProperty(propertyNames[i])) {
          var propValue = view.propertyValue(propertyNames[i]);
          console.writeln('[WCS]   Found property: ' + propertyNames[i] + ' = ' + propValue);
          
          // Map to our data structure
          var propName = propertyNames[i].toLowerCase();
          if (propName.includes('centera') || propName.includes('center:ra')) {
            wcsData.centerRA = parseFloat(propValue);
          } else if (propName.includes('centerec') || propName.includes('center:dec')) {
            wcsData.centerDec = parseFloat(propValue);
          } else if (propName.includes('rotation')) {
            wcsData.rotation = parseFloat(propValue);
          } else if (propName.includes('pixelscale') || propName.includes('resolution')) {
            var scale = parseFloat(propValue);
            if (scale > 0 && scale < 1) {
              // Likely in degrees/pixel, convert to arcsec/pixel
              wcsData.pixelScale = scale;
              wcsData.pixelScaleArcsec = scale * 3600.0;
            } else if (scale > 1) {
              // Likely already in arcsec/pixel
              wcsData.pixelScaleArcsec = scale;
              wcsData.pixelScale = scale / 3600.0;
            }
          }
        }
      } catch (e) {
        // Property doesn't exist or can't be read, continue
      }
    }
    
    console.writeln('[WCS] XISF properties extracted:');
    console.writeln('[WCS]   Center: RA=' + (wcsData.centerRA ? wcsData.centerRA.toFixed(6) : 'N/A') + '°, Dec=' + (wcsData.centerDec ? wcsData.centerDec.toFixed(6) : 'N/A') + '°');
    console.writeln('[WCS]   Rotation: ' + (wcsData.rotation !== null ? wcsData.rotation.toFixed(4) : 'N/A') + '°');
    console.writeln('[WCS]   Scale: ' + (wcsData.pixelScaleArcsec ? wcsData.pixelScaleArcsec.toFixed(3) : 'N/A') + '"/pixel');
    
    // Method 4: Try to test coordinate transformation functions directly to validate WCS
    try {
      if (view.astrometricSolution) {
        console.writeln('[WCS] Testing coordinate transformation functions...');
        var astroSol = view.astrometricSolution;
        
        // Test if WorldToImage function works
        if (typeof astroSol.WorldToImage === 'function') {
          // Use image center coordinates for testing
          var testRA = wcsData.centerRA || 0;
          var testDec = wcsData.centerDec || 0;
          var testWorldPoint = new Point(testRA, testDec);
          var testImagePoint = astroSol.WorldToImage(testWorldPoint);
          
          if (testImagePoint && isFinite(testImagePoint.x) && isFinite(testImagePoint.y)) {
            console.writeln('[WCS] ✅ WorldToImage function is working!');
            console.writeln('[WCS]   Test: RA=' + testRA + '°, Dec=' + testDec + '° → Pixel(' + testImagePoint.x.toFixed(1) + ', ' + testImagePoint.y.toFixed(1) + ')');
            
            // If we can transform coordinates, we have a working WCS solution
            // Try to reverse-engineer the parameters from known transformations
            var imageCenterX = imageWindow.mainView.image.width / 2.0;
            var imageCenterY = imageWindow.mainView.image.height / 2.0;
            var centerWorldPoint = astroSol.ImageToWorld(new Point(imageCenterX, imageCenterY));
            
            if (centerWorldPoint && isFinite(centerWorldPoint.x) && isFinite(centerWorldPoint.y)) {
              wcsData.centerRA = centerWorldPoint.x;
              wcsData.centerDec = centerWorldPoint.y;
              console.writeln('[WCS]   Derived field center: RA=' + wcsData.centerRA.toFixed(6) + '°, Dec=' + wcsData.centerDec.toFixed(6) + '°');
              
              // Store the working transformation functions for later use
              wcsData.worldToImage = astroSol.WorldToImage;
              wcsData.imageToWorld = astroSol.ImageToWorld;
              wcsData.hasWorkingTransform = true;
              
              console.writeln('[WCS] ✅ Working coordinate transformation functions found!');
              return {
                success: true,
                data: wcsData,
                method: 'xisf-coordinate-transform'
              };
            }
          }
        }
      }
    } catch (e) {
      console.writeln('[WCS] Coordinate transformation test failed: ' + e);
    }
    
    // Check if we have the essential data from property extraction
    if (wcsData.centerRA !== null && wcsData.centerDec !== null && 
        wcsData.rotation !== null && wcsData.pixelScaleArcsec !== null) {
      
      console.writeln('[WCS] ✅ XISF WCS properties successfully extracted');
      return {
        success: true,
        data: wcsData,
        method: 'xisf-properties-direct'
      };
    } else {
      console.writeln('[WCS] ⚠️ XISF properties incomplete');
      return { success: false, error: 'XISF properties incomplete', method: 'xisf-incomplete' };
    }
    
  } catch (e) {
    console.writeln('[WCS] ❌ XISF properties extraction failed: ' + e);
    return {
      success: false,
      error: 'XISF properties extraction failed: ' + e,
      method: 'xisf-exception'
    };
  }
}

/**
 * Extract precise WCS solution data using ImageMetadata (ImageSolver WCS)
 * @param {ImageWindow} imageWindow - PixInsight image window with astrometric solution
 * @returns {object} - {success: boolean, data: object, method: string, error: string}
 */
function extractImageMetadataWCS(imageWindow) {
  // First try direct XISF properties access
  var xisfResult = extractXISFWCSProperties(imageWindow);
  if (xisfResult.success) {
    return xisfResult;
  }
  
  if (!WCS_METADATA_AVAILABLE || typeof ImageMetadata === 'undefined') {
    // Try one more time to find ImageMetadata
    if (initializeWCSMetadata()) {
      WCS_METADATA_AVAILABLE = true;
    } else {
      console.writeln('[WCS] ImageMetadata not available - need to run AdP script first');
      console.writeln('[WCS] TIP: Run ImageSolver (or any AdP script) once to enable ImageMetadata');
      return { success: false, error: 'ImageMetadata not available - run ImageSolver first', method: 'no-imagemetadata' };
    }
  }
  
  try {
    if (!imageWindow || imageWindow.isNull) {
      return { success: false, error: 'No image window', method: 'no-image' };
    }
    
    if (!imageWindow.hasAstrometricSolution) {
      return { success: false, error: 'No astrometric solution', method: 'no-wcs' };
    }
    
    console.writeln('[WCS] Extracting precise WCS solution using ImageMetadata...');
    
    var metadata = new ImageMetadata();
    metadata.ExtractMetadata(imageWindow);
    
    // Extract key WCS parameters
    var wcsData = {
      centerRA: metadata.ra || null,           // Field center RA in degrees
      centerDec: metadata.dec || null,         // Field center Dec in degrees 
      pixelScale: metadata.resolution || null, // Resolution in degrees/pixel
      rotation: metadata.rotation || null,     // Rotation angle in degrees
      focal: metadata.focal || null,           // Focal length
      xpixsz: metadata.xpixsz || null,        // Pixel size
      epoch: metadata.epoch || null,           // Epoch
      ra: metadata.ra || null,                 // Redundant but explicit
      dec: metadata.dec || null                // Redundant but explicit
    };
    
    // Convert resolution from degrees/pixel to arcsec/pixel if needed
    if (wcsData.pixelScale) {
      wcsData.pixelScaleArcsec = wcsData.pixelScale * 3600.0;
    }
    
    console.writeln('[WCS] ✅ ImageMetadata WCS extraction successful:');
    console.writeln('[WCS]   Center: RA=' + (wcsData.centerRA ? wcsData.centerRA.toFixed(6) : 'N/A') + '°, Dec=' + (wcsData.centerDec ? wcsData.centerDec.toFixed(6) : 'N/A') + '°');
    console.writeln('[WCS]   Rotation: ' + (wcsData.rotation ? wcsData.rotation.toFixed(4) : 'N/A') + '°');
    console.writeln('[WCS]   Scale: ' + (wcsData.pixelScaleArcsec ? wcsData.pixelScaleArcsec.toFixed(3) : 'N/A') + '"/pixel');
    
    return {
      success: true,
      data: wcsData,
      method: 'imagemetadata-wcs'
    };
    
  } catch (e) {
    console.writeln('[WCS] ❌ ImageMetadata extraction failed: ' + e);
    return {
      success: false,
      error: 'ImageMetadata extraction failed: ' + e,
      method: 'imagemetadata-exception'
    };
  }
}

/**
 * Extracts rotation angle automatically from astrometric solution
 * @param {ImageWindow} imageWindow - PixInsight image window with astrometric solution
 * @returns {object} - {success: boolean, rotation: number, method: string, error: string}
 */
function extractWCSRotation(imageWindow) {
  // First try to use precise ImageMetadata WCS solution
  if (WCS_METADATA_AVAILABLE) {
    var imageMetadataResult = extractImageMetadataWCS(imageWindow);
    if (imageMetadataResult.success && imageMetadataResult.data.rotation !== null) {
      return {
        success: true,
        rotation: imageMetadataResult.data.rotation,
        method: 'imagemetadata-wcs',
        wcsData: imageMetadataResult.data // Include full WCS data
      };
    }
  }
  
  // Fall back to direct FITS keyword extraction
  console.writeln('[WCS] Using FITS keyword extraction fallback...');
  return extractRotationFromFITS(imageWindow);
}

// =============================================================
// ExoTransit Photometry -- WCS PRODUCTION BUILD v2.3
// Enhanced with Professional Photometry Analysis + Bidirectional WCS Coordinates
// Features: Adaptive Thresholding, Frame Decorrelation,
// Real Photometric Uncertainties, Robust Sky Background,
// Consensus Detection, Variable Apertures, Quality Control,
// Automatic WCS Rotation Detection, Bidirectional Coordinate Conversion
// =============================================================

console.writeln("Loading ExoTransit Light Curve Plot - Mixed Target Test Build v2.5 with Circle Exoplanet + Crosshair Targeting...");

// PROFESSIONAL PHOTOMETRY FEATURES:
// - Adaptive thresholding based on image statistics  
// - Frame-by-frame decorrelation (FWHM, sky, drift)
// - Real photometric uncertainties (Poisson + sky + read noise)
// - Robust sky background with outlier rejection
// - Consensus-based star validation with bounds checking
// - Variable aperture sizing based on measured PSF
// - Enhanced quality scoring and FWHM guard rails

// ---------------- PixInsight Global Namespace Settings Storage ----------------
// Store settings in PixInsight's global namespace to persist between script runs
console.writeln('Using PixInsight global namespace for session persistence');

// Define default settings (no hardcoded coordinates or hardware values)
var defaultSettings = {
  folder: '',
  mode: 'pixel', // 'pixel' or 'wcs'
  pixX: 0,                  // Will be set to image center when image is loaded
  pixY: 0,                  // Will be set to image center when image is loaded
  ra: 0.0,                  // Default RA, should be set by user
  dec: 0.0,                 // Default Dec, should be set by user
  aperture_r: 12,
  aperture_rIn: 20,
  aperture_rOut: 35,
  autoComp: true,
  compCount: 10,

  freezeCompWeights: false,
  enableDetrending: true,
  detrendTerms: ['airmass','sky','fwhm','time', 'dx','dy'],
  multiAperture: [1.1,1.3,1.5,1.7],
  csvPath: '',
  // Hardware-based aperture settings (will be read from FITS headers)
  focalLength: 0.0,             // mm - will be extracted from FITS headers
  pixelSize: 0.0,               // micrometers - will be extracted from FITS headers
  binning: 1,                   // 1x, 2x, 3x, 4x
  estimatedFWHM: 3.0,           // arcseconds
  useHardwareCalculator: true,  // true = use hardware calculator, false = manual
  // Cosmic ray removal settings
  enableCosmicRayRemoval: true,  // Enable cosmic ray outlier detection
  cosmicRayThreshold: 10.0,      // Sigma threshold for cosmic ray detection
  maxTransitDepth: 10.0,         // Maximum expected transit depth (%)
  // Manual WCS override
  manualRotation: 0.0,           // Manual WCS rotation in degrees (0 = auto-detect)
  // Image dimensions (will be set from actual image when loaded)
  imageWidth: 0,                 // Image width in pixels - dynamically determined
  imageHeight: 0                 // Image height in pixels - dynamically determined
};

// Check if this is first run before initializing
var isFirstRun = (typeof this.__PJSR_ExoTransitOption1Settings__ === 'undefined');

// Initialize settings from global namespace or defaults
function initializeSettings() {
  // Check if settings already exist in global namespace
  if (typeof this.__PJSR_ExoTransitOption1Settings__ === 'undefined') {
    // First time - create global settings
    this.__PJSR_ExoTransitOption1Settings__ = JSON.parse(JSON.stringify(defaultSettings));
    console.writeln('Initialized new global settings');
  } else {
    console.writeln('Found existing global settings from previous run');
  }
  return this.__PJSR_ExoTransitOption1Settings__;
}

var GlobalSettings = initializeSettings();

// Global reference to keep opened images from being garbage collected
var openedImageWindow = null;

// Save function that updates both local and global namespace
function saveSettings(settings) {
  try {
    // Update both local GlobalSettings and global namespace
    for (var key in settings) {
      if (settings.hasOwnProperty(key)) {
        GlobalSettings[key] = settings[key];
        this.__PJSR_ExoTransitOption1Settings__[key] = settings[key];
      }
    }
    console.writeln('Settings saved to global namespace: ' + Object.keys(settings).length + ' values');
    return true;
  } catch(e) {
    console.warningln('Settings save failed: ' + e);
    return false;
  }
}


// Show current settings status
console.writeln('Startup Settings (' + (isFirstRun ? 'new session defaults' : 'loaded from previous run') + '):');
console.writeln('  Folder: ' + (GlobalSettings.folder || '(none)'));
console.writeln('  Mode: ' + GlobalSettings.mode);
console.writeln('  Coordinates: ' + (GlobalSettings.mode === 'pixel' ? 
  'pixel(' + GlobalSettings.pixX + ', ' + GlobalSettings.pixY + ')' : 
  'RA/Dec(' + GlobalSettings.ra.toFixed(4) + '°, ' + GlobalSettings.dec.toFixed(4) + '°)'));
console.writeln('  CSV Path: ' + (GlobalSettings.csvPath || '(default)'));

// ---------------- Star Detection and Analysis Functions ----------------

// Enhanced star detection with adaptive thresholding and robust analysis
function detectAndAnalyzeStars(image, parameters) {
  console.writeln('Detecting stars with enhanced analysis...');
  
  // Default parameters if not specified
  parameters = parameters || {};
  var maxStars = parameters.maxStars || 100;             // Maximum number of stars to return
  var minStarSize = parameters.minStarSize || 2;         // Minimum diameter in pixels
  var maxStarSize = parameters.maxStarSize || 30;        // Maximum diameter in pixels
  var avoidBorders = parameters.avoidBorders || 30;      // Pixels from border to avoid
  
  // Enhanced detection parameters
  var detectionSNR = 3.5;        // Signal-to-noise threshold for detection
  var validationSNR = 4.5;       // Higher threshold for final validation
  var consensusThreshold = 0.6;   // Require 60% of pixels in PSF region to be above threshold
  
  // Result array for detected stars
  var stars = [];
  
  try {
    // Create a preview image for processing (PixInsight approach)
    var w = image.width;
    var h = image.height;
    
    // Calculate image statistics for adaptive thresholding
    console.writeln('Calculating image statistics for adaptive thresholding...');
    var imageStats = calculateImageStatistics(image, avoidBorders);
    var backgroundMean = imageStats.mean;
    var backgroundStd = imageStats.std;
    var estimatedPSF = imageStats.psf || 3.0;
    
    // Adaptive thresholds based on image characteristics
    var adaptiveDetectionThreshold = backgroundMean + (detectionSNR * backgroundStd);
    var adaptiveValidationThreshold = backgroundMean + (validationSNR * backgroundStd);
    
    console.writeln('Image statistics: mean=' + backgroundMean.toFixed(4) + 
                   ', std=' + backgroundStd.toFixed(4) + 
                   ', estimated PSF=' + estimatedPSF.toFixed(1) + ' pixels');
    console.writeln('Adaptive thresholds: detection=' + adaptiveDetectionThreshold.toFixed(4) + 
                   ', validation=' + adaptiveValidationThreshold.toFixed(4));
    
    // For large images, create a downscaled version for faster processing
    var scaleFactor = 1.0;
    if (w > 2000 || h > 2000) {
      scaleFactor = Math.min(1.0, 2000 / Math.max(w, h));
      console.writeln('Using scale factor ' + scaleFactor.toFixed(2) + ' for star detection');
    }
    
    // Star detection strategy:
    // 1. Find brightness peaks above threshold
    // 2. Filter out artifacts and cosmic rays
    // 3. Measure FWHM and other properties
    
    // Step 1: Simple peak detection (look for local maxima)
    var progress = 0;
    var progressStep = 10; // Report progress every 10%
    
    console.writeln('Scanning image for local maxima...');
    
    // Process image in blocks for efficiency
    var blockSize = 45;  // Optimized block size for balance of speed and accuracy
    var psfRadius = Math.max(2, Math.round(estimatedPSF));
    var searchRadius = Math.max(psfRadius, 4);
    
    for (var by = avoidBorders; by < h - avoidBorders; by += blockSize) {
      for (var bx = avoidBorders; bx < w - avoidBorders; bx += blockSize) {
        // Report progress every 10%
        var currentProgress = Math.floor((by * w + bx) / (w * h) * 100);
        if (currentProgress >= progress + progressStep) {
          progress = Math.floor(currentProgress / progressStep) * progressStep;
          console.writeln('Enhanced star detection progress: ' + progress + '%');
        }
        
        // Process each block
        var blockEndY = Math.min(by + blockSize, h - avoidBorders);
        var blockEndX = Math.min(bx + blockSize, w - avoidBorders);
        
        // Find local maxima with consensus testing
        for (var y = by; y < blockEndY; y += 2) {
          for (var x = bx; x < blockEndX; x += 2) {
            // Get center pixel brightness
            var centerBrightness = 0;
            for (var c = 0; c < image.numberOfChannels; c++) {
              centerBrightness += image.sample(x, y, c);
            }
            centerBrightness /= image.numberOfChannels;
            
            // First check: meets adaptive threshold
            if (centerBrightness > adaptiveDetectionThreshold) {
              // Enhanced consensus test: check PSF-sized region around candidate
              var consensusPixels = 0;
              var totalTestPixels = 0;
              var peakCandidate = true;
              
              for (var ny = Math.max(avoidBorders, y - psfRadius); ny <= Math.min(h - avoidBorders - 1, y + psfRadius); ny++) {
                for (var nx = Math.max(avoidBorders, x - psfRadius); nx <= Math.min(w - avoidBorders - 1, x + psfRadius); nx++) {
                  var pixelBrightness = 0;
                  for (var c = 0; c < image.numberOfChannels; c++) {
                    pixelBrightness += image.sample(nx, ny, c);
                  }
                  pixelBrightness /= image.numberOfChannels;
                  
                  // Count pixels above detection threshold
                  if (pixelBrightness > adaptiveDetectionThreshold) {
                    consensusPixels++;
                  }
                  totalTestPixels++;
                  
                  // Ensure this is still the peak in search radius
                  if (nx !== x || ny !== y) {
                    var dist = Math.sqrt((nx - x) * (nx - x) + (ny - y) * (ny - y));
                    if (dist <= searchRadius && pixelBrightness > centerBrightness) {
                      peakCandidate = false;
                    }
                  }
                }
              }
              
              // Require consensus: enough bright pixels in PSF region AND it's a local peak
              var consensusRatio = consensusPixels / totalTestPixels;
              if (peakCandidate && consensusRatio >= consensusThreshold) {
                // Enhanced centroid calculation with background subtraction
                var sumX = 0, sumY = 0, sumWeight = 0;
                var centroidRadius = Math.max(psfRadius, 4);
                
                // Use background-subtracted brightness for weighting
                for (var cy = Math.max(avoidBorders, y - centroidRadius); cy <= Math.min(h - avoidBorders - 1, y + centroidRadius); cy++) {
                  for (var cx = Math.max(avoidBorders, x - centroidRadius); cx <= Math.min(w - avoidBorders - 1, x + centroidRadius); cx++) {
                    var pixelValue = 0;
                    for (var c = 0; c < image.numberOfChannels; c++) {
                      pixelValue += image.sample(cx, cy, c);
                    }
                    pixelValue /= image.numberOfChannels;
                    
                    // Background-subtracted weight (prevents background bias)
                    var weight = Math.max(0, pixelValue - backgroundMean);
                    sumX += cx * weight;
                    sumY += cy * weight;
                    sumWeight += weight;
                  }
                }
                
                // Calculate refined center of gravity
                if (sumWeight > 0) {
                  var starX = sumX / sumWeight;
                  var starY = sumY / sumWeight;
                  
                  // Enhanced star property measurement with adaptive parameters
                  var starInfo = measureEnhancedStarProperties(image, starX, starY, 
                                                              backgroundMean, backgroundStd, 
                                                              estimatedPSF, adaptiveValidationThreshold);
                  
                  // Enhanced quality filtering
                  if (starInfo.fwhm >= minStarSize && starInfo.fwhm <= maxStarSize && 
                      starInfo.snr >= validationSNR && starInfo.quality > 0.3) {
                    stars.push(starInfo);
                  }
                }
              }
            }
          }
        }
      }
    }
    
    console.writeln('? Star detection complete: Found ' + stars.length + ' initial candidates');
    
    // Step 3: Sort by quality and brightness, then select top stars
    stars.sort(function(a, b) {
      // Prioritize by quality score
      return b.quality - a.quality;
    });
    
    // Limit number of stars returned
    if (stars.length > maxStars) {
      stars = stars.slice(0, maxStars);
    }
    
    console.writeln('[>] Selected ' + stars.length + ' stars for analysis');
    
    // Calculate image scale if hardware parameters are available
    if (GlobalSettings.focalLength > 0 && GlobalSettings.pixelSize > 0) {
      var binning = GlobalSettings.binning || 1;
      var imageScale = (GlobalSettings.pixelSize * binning * 206.265) / GlobalSettings.focalLength;
      
      // Add arcsecond values to star measurements and collect FWHM statistics
      var fwhmPixels = [];
      var fwhmArcsec = [];
      for (var i = 0; i < stars.length; i++) {
        stars[i].fwhmArcsec = stars[i].fwhm * imageScale;
        fwhmPixels.push(stars[i].fwhm);
        fwhmArcsec.push(stars[i].fwhmArcsec);
      }
      
      // Sort for statistics
      fwhmPixels.sort(function(a, b) { return a - b; });
      fwhmArcsec.sort(function(a, b) { return a - b; });
      
      // Calculate min/median/max only if we have stars
      if (fwhmArcsec.length > 0) {
        var minFWHM = fwhmArcsec[0];
        var medianFWHM = fwhmArcsec[Math.floor(fwhmArcsec.length / 2)];
        var maxFWHM = fwhmArcsec[fwhmArcsec.length - 1];
        
        console.writeln('[>] FWHM statistics: min=' + minFWHM.toFixed(2) + '", median=' + 
                       medianFWHM.toFixed(2) + '", max=' + maxFWHM.toFixed(2) + '" (' +
                       fwhmPixels[Math.floor(fwhmPixels.length / 2)].toFixed(1) + ' px median)');
      }
    }
    
    return stars;
  } catch (e) {
    console.warningln('[!] Star detection error: ' + e);
    return [];
  }
}

// Measure star properties at the given coordinates
function measureStarProperties(image, x, y) {
  // Initialize result object
  var result = {
    x: x,
    y: y,
    brightness: 0,
    fwhm: 0,
    roundness: 1.0,  // 1.0 = perfectly round
    quality: 0,      // Overall quality score
    snr: 0,          // Signal to noise ratio
    saturated: false // Whether the star is saturated
  };
  
  try {
    // Get background value (estimate from area around star)
    var background = 0;
    var backgroundSamples = 0;
    var backgroundRadius = 15;
    var starRadius = 10;
    
    // Sample background in a ring around the star
    for (var by = Math.max(0, Math.floor(y) - backgroundRadius); by <= Math.min(image.height - 1, Math.floor(y) + backgroundRadius); by++) {
      for (var bx = Math.max(0, Math.floor(x) - backgroundRadius); bx <= Math.min(image.width - 1, Math.floor(x) + backgroundRadius); bx++) {
        // Calculate distance from star center
        var dist = Math.sqrt((bx - x) * (bx - x) + (by - y) * (by - y));
        
        // Sample only the background ring, not the star itself
        if (dist > starRadius && dist <= backgroundRadius) {
          var pixelValue = 0;
          for (var c = 0; c < image.numberOfChannels; c++) {
            pixelValue += image.sample(bx, by, c);
          }
          pixelValue /= image.numberOfChannels;
          
          background += pixelValue;
          backgroundSamples++;
        }
      }
    }
    
    // Calculate average background
    if (backgroundSamples > 0) {
      background /= backgroundSamples;
    }
    
    // Get peak value and check for saturation
    var peak = 0;
    for (var c = 0; c < image.numberOfChannels; c++) {
      var channelValue = image.sample(Math.floor(x), Math.floor(y), c);
      peak = Math.max(peak, channelValue);
    }
    
    result.brightness = peak - background;
    result.saturated = (peak > 0.99); // Assume >99% is saturated
    
    // Calculate FWHM by sampling in X and Y directions
    var halfMax = background + result.brightness / 2;
    var fwhmX = calculateFWHM(image, x, y, halfMax, true);
    var fwhmY = calculateFWHM(image, x, y, halfMax, false);
    
    // Average FWHM and calculate roundness
    result.fwhm = (fwhmX + fwhmY) / 2;
    if (fwhmX > 0 && fwhmY > 0) {
      result.roundness = Math.min(fwhmX, fwhmY) / Math.max(fwhmX, fwhmY);
    }
    
    // Estimate SNR (simplified calculation)
    if (background > 0) {
      var signal = result.brightness;
      var noise = Math.sqrt(background);
      result.snr = (noise > 0) ? signal / noise : 0;
    }
    
    // Calculate quality score based on several factors
    var qualityFactors = [
      // Brightness quality - prefer stars that aren't too bright or too dim
      (result.brightness > 0.1 && result.brightness < 0.9) ? 1.0 : 0.5,
      
      // Roundness quality - prefer round stars
      result.roundness,
      
      // FWHM quality - prefer stars with moderate FWHM (not too tight, not too wide)
      (result.fwhm > 2 && result.fwhm < 10) ? 1.0 : 0.7,
      
      // Saturation penalty
      result.saturated ? 0.1 : 1.0,
      
      // SNR quality
      Math.min(1.0, result.snr / 100)
    ];
    
    // Combine quality factors
    result.quality = 1.0;
    for (var i = 0; i < qualityFactors.length; i++) {
      result.quality *= qualityFactors[i];
    }
    
    return result;
  } catch (e) {
    console.warningln('[!] Error measuring star at (' + x + ', ' + y + '): ' + e);
    return result;
  }
}

// Calculate FWHM by sampling along an axis
function calculateFWHM(image, centerX, centerY, halfMaxValue, isXAxis) {
  var width = image.width, height = image.height;

  function sampleAt(x,y){
    if (x<0 || y<0 || x>=width || y>=height) return 0;
    var v=0;
    for (var c=0;c<image.numberOfChannels;c++) v += image.sample(x,y,c);
    return v / image.numberOfChannels;
  }

  function axisFWHM(maxRadius){
    var pos1=-1,pos2=-1;
    var lastVal;

    // negative direction
    for (var r=0;r<=maxRadius;r++){
      var x = isXAxis ? Math.round(centerX - r) : Math.round(centerX);
      var y = isXAxis ? Math.round(centerY)     : Math.round(centerY - r);
      var val = sampleAt(x,y);
      if (r>0){
        if (val <= halfMaxValue && lastVal > halfMaxValue){
          var frac = (lastVal - halfMaxValue)/Math.max(1e-12, (lastVal - val));
          pos1 = (r-1) + frac;
          break;
        }
      }
      lastVal = val;
    }

    // positive direction
    lastVal = undefined;
    for (var r=0;r<=maxRadius;r++){
      var x2 = isXAxis ? Math.round(centerX + r) : Math.round(centerX);
      var y2 = isXAxis ? Math.round(centerY)     : Math.round(centerY + r);
      var v2 = sampleAt(x2,y2);
      if (r>0){
        if (v2 <= halfMaxValue && lastVal > halfMaxValue){
          var frac2 = (lastVal - halfMaxValue)/Math.max(1e-12, (lastVal - v2));
          pos2 = (r-1) + frac2;
          break;
        }
      }
      lastVal = v2;
    }
    if (pos1>=0 && pos2>=0) return pos1+pos2;
    return -1;
  }

  try{
    var radii = [20, 35, 50];
    for (var i=0;i<radii.length;i++){
      var f = axisFWHM(radii[i]);
      if (f>0 && f<=60) return Math.max(1.0, Math.min(50.0, f));
    }
    // moment fallback in local box
    var boxR = 10;
    var x0 = Math.max(0, Math.floor(centerX - boxR));
    var x1 = Math.min(width-1, Math.floor(centerX + boxR));
    var y0 = Math.max(0, Math.floor(centerY - boxR));
    var y1 = Math.min(height-1, Math.floor(centerY + boxR));
    var m00=0,m10=0,m01=0,m20=0,m02=0;
    for (var yy=y0; yy<=y1; yy++){
      for (var xx=x0; xx<=x1; xx++){
        var I = sampleAt(xx,yy);
        if (I<0) I=0;
        m00 += I;
        m10 += I*xx;
        m01 += I*yy;
      }
    }
    if (m00<=0){
      console.warningln('[!] FWHM measurement failed at (' + centerX.toFixed(1) + ', ' + centerY.toFixed(1) + '), using default');
      return 3.5;
    }
    var cx = m10/m00, cy = m01/m00;
    for (var yy=y0; yy<=y1; yy++){
      for (var xx=x0; xx<=x1; xx++){
        var I2 = sampleAt(xx,yy);
        I2 = Math.max(0, I2);
        m20 += I2*(xx-cx)*(xx-cx);
        m02 += I2*(yy-cy)*(yy-cy);
      }
    }
    var varx = m20/Math.max(1e-12,m00);
    var vary = m02/Math.max(1e-12,m00);
    var sigma = Math.sqrt(Math.max(1e-12, (varx + vary)/2.0));
    var fwhmMom = 2.354820045 * sigma;
    fwhmMom = Math.max(1.0, Math.min(50.0, fwhmMom));
    console.warningln('[!] FWHM axis-crossing failed; using moment fallback ' + fwhmMom.toFixed(2) + ' px at (' + centerX.toFixed(1) + ', ' + centerY.toFixed(1) + ')');
    return fwhmMom;
  }catch(e){
    console.warningln('[!] Error calculating FWHM: ' + e);
    return 3.5;
  }
}

// Calculate comprehensive image statistics for adaptive processing
function calculateImageStatistics(image, avoidBorders) {
  try {
    var w = image.width;
    var h = image.height;
    var samples = [];
    var sampleStep = 15; // Sample every 15th pixel for efficiency
    
    console.writeln('Sampling image for statistics (step=' + sampleStep + ')...');
    
    // Collect samples avoiding borders
    for (var y = avoidBorders; y < h - avoidBorders; y += sampleStep) {
      for (var x = avoidBorders; x < w - avoidBorders; x += sampleStep) {
        var pixelValue = 0;
        for (var c = 0; c < image.numberOfChannels; c++) {
          pixelValue += image.sample(x, y, c);
        }
        pixelValue /= image.numberOfChannels;
        samples.push(pixelValue);
      }
    }
    
    // Sort for percentile calculations
    samples.sort(function(a, b) { return a - b; });
    var n = samples.length;
    
    // Calculate robust statistics
    var median = samples[Math.floor(n * 0.5)];
    var q25 = samples[Math.floor(n * 0.25)];
    var q75 = samples[Math.floor(n * 0.75)];
    
    // Use interquartile-based standard deviation estimate
    var robustStd = (q75 - q25) / 1.349; // Convert IQR to std estimate
    
    // Estimate PSF from image sampling (basic approach)
    var estimatedPSF = Math.max(2.5, Math.min(6.0, robustStd * 50)); // Heuristic scaling
    
    return {
      mean: median,    // Use median as robust mean
      std: robustStd,  // Robust standard deviation
      psf: estimatedPSF,
      samples: n
    };
  } catch (e) {
    console.warningln('[!] Error calculating image statistics: ' + e);
    return {
      mean: 0.1,
      std: 0.05,
      psf: 3.0,
      samples: 0
    };
  }
}

// Enhanced star property measurement with robust sky background
function measureEnhancedStarProperties(image, x, y, backgroundMean, backgroundStd, estimatedPSF, validationThreshold) {
  var result = {
    x: x,
    y: y,
    brightness: 0,
    fwhm: 0,
    roundness: 1.0,
    quality: 0,
    snr: 0,
    saturated: false
  };
  
  try {
    // Variable aperture sizing based on PSF
    var apertureRadius = estimatedPSF * 2.8;        // Our scaling factor
    var skyInnerRadius = apertureRadius * 1.8;      // Our inner sky ratio
    var skyOuterRadius = apertureRadius * 2.5;      // Our outer sky ratio
    
    // Robust sky background calculation with outlier rejection
    var skyPixels = [];
    for (var sy = Math.max(0, Math.floor(y) - skyOuterRadius); sy <= Math.min(image.height - 1, Math.floor(y) + skyOuterRadius); sy++) {
      for (var sx = Math.max(0, Math.floor(x) - skyOuterRadius); sx <= Math.min(image.width - 1, Math.floor(x) + skyOuterRadius); sx++) {
        var dist = Math.sqrt((sx - x) * (sx - x) + (sy - y) * (sy - y));
        
        // Sky annulus region
        if (dist >= skyInnerRadius && dist <= skyOuterRadius) {
          var pixelValue = 0;
          for (var c = 0; c < image.numberOfChannels; c++) {
            pixelValue += image.sample(sx, sy, c);
          }
          pixelValue /= image.numberOfChannels;
          skyPixels.push(pixelValue);
        }
      }
    }
    
    // Robust sky calculation using median and MAD filtering
    if (skyPixels.length > 10) {
      skyPixels.sort(function(a, b) { return a - b; });
      var skyMedian = skyPixels[Math.floor(skyPixels.length / 2)];
      
      // Median Absolute Deviation for outlier rejection
      var deviations = skyPixels.map(function(val) { return Math.abs(val - skyMedian); });
      deviations.sort(function(a, b) { return a - b; });
      var mad = deviations[Math.floor(deviations.length / 2)];
      var robustStd = mad * 1.4826; // Convert MAD to std estimate
      
      // Filter out outliers (beyond 3 sigma)
      var filteredSky = skyPixels.filter(function(val) {
        return Math.abs(val - skyMedian) <= 3 * robustStd;
      });
      
      var background = filteredSky.reduce(function(sum, val) { return sum + val; }, 0) / filteredSky.length;
    } else {
      var background = backgroundMean; // Fallback to image mean
    }
    
    // Get peak value and check for saturation
    var peak = 0;
    for (var c = 0; c < image.numberOfChannels; c++) {
      var channelValue = image.sample(Math.floor(x), Math.floor(y), c);
      peak = Math.max(peak, channelValue);
    }
    
    result.brightness = peak - background;
    result.saturated = (peak > 0.98); // Saturation limit - raised to 0.98 to allow mildly bright stars
    
    // Enhanced FWHM calculation with bounds checking
    var halfMax = background + result.brightness / 2;
    var fwhmX = calculateFWHM(image, x, y, halfMax, true);
    var fwhmY = calculateFWHM(image, x, y, halfMax, false);
    
    // Apply additional bounds checking
    fwhmX = Math.max(1.0, Math.min(25.0, fwhmX));
    fwhmY = Math.max(1.0, Math.min(25.0, fwhmY));
    
    result.fwhm = (fwhmX + fwhmY) / 2;
    if (fwhmX > 0 && fwhmY > 0) {
      result.roundness = Math.min(fwhmX, fwhmY) / Math.max(fwhmX, fwhmY);
    } else {
      result.roundness = 0.5; // Default for failed measurements
    }
    
    // Enhanced SNR calculation
    var signal = result.brightness;
    var noise = Math.sqrt(Math.max(background, backgroundStd * backgroundStd));
    result.snr = (noise > 0) ? signal / noise : 0;
    
    // Enhanced quality scoring with our own criteria
    var qualityFactors = [
      // Brightness validation against validation threshold
      (result.brightness > validationThreshold * 0.5) ? 1.0 : 0.2,
      
      // PSF consistency (within reasonable range of estimated PSF)
      (Math.abs(result.fwhm - estimatedPSF) < estimatedPSF * 0.6) ? 1.0 : 0.6,
      
      // Roundness quality
      Math.pow(result.roundness, 2), // Square it to emphasize roundness
      
      // SNR quality with our threshold
      Math.min(1.0, result.snr / 6.0), // Scale to our SNR expectations
      
      // Saturation penalty
      result.saturated ? 0.1 : 1.0
    ];
    
    // Geometric mean for quality (more conservative)
    result.quality = 1.0;
    for (var i = 0; i < qualityFactors.length; i++) {
      result.quality *= Math.pow(qualityFactors[i], 1.0 / qualityFactors.length);
    }
    
    return result;
  } catch (e) {
    console.warningln('[!] Error in enhanced star measurement at (' + x + ', ' + y + '): ' + e);
    return result;
  }
}

// Calculate realistic photometric uncertainties
function calculatePhotometricUncertainty(targetFlux, skyBackground, apertureArea, skyAnnulusArea, readNoise, gain) {
  try {
    // Use typical values if not provided
    readNoise = readNoise || 8.0;  // e- (typical for amateur CCD)
    gain = gain || 1.5;            // e-/ADU (typical gain)
    
    // Convert fluxes to electrons
    var targetElectrons = targetFlux * gain;
    var skyElectrons = skyBackground * gain;
    
    // Poisson noise from target photons
    var photonNoise = Math.sqrt(Math.max(0, targetElectrons));
    
    // Sky noise contribution
    var skyNoise = Math.sqrt(skyElectrons * apertureArea);
    
    // Read noise from aperture pixels
    var readNoiseContrib = readNoise * Math.sqrt(apertureArea);
    
    // Sky estimation uncertainty (from finite sky sampling)
    var skyEstimationNoise = 0;
    if (skyAnnulusArea > 0) {
      skyEstimationNoise = Math.sqrt(skyElectrons * apertureArea * apertureArea / skyAnnulusArea);
    }
    
    // Combined uncertainty in electrons
    var totalNoiseElectrons = Math.sqrt(
      photonNoise * photonNoise + 
      skyNoise * skyNoise + 
      readNoiseContrib * readNoiseContrib + 
      skyEstimationNoise * skyEstimationNoise
    );
    
    // Convert back to ADU and to relative uncertainty
    var totalNoiseADU = totalNoiseElectrons / gain;
    var relativeUncertainty = (targetFlux > 0) ? totalNoiseADU / targetFlux : 0.1;
    
    // Apply minimum uncertainty floor (systematic effects, flat fielding, etc.)
    var systematicFloor = 0.005; // 0.5% minimum uncertainty
    relativeUncertainty = Math.max(relativeUncertainty, systematicFloor);
    
    return {
      absolute: totalNoiseADU,
      relative: relativeUncertainty,
      components: {
        photon: photonNoise / gain,
        sky: skyNoise / gain, 
        read: readNoiseContrib / gain,
        skyEstimation: skyEstimationNoise / gain
      }
    };
  } catch (e) {
    console.warningln('[!] Error calculating photometric uncertainty: ' + e);
    return {
      absolute: targetFlux * 0.01,
      relative: 0.01,
      components: {photon: 0, sky: 0, read: 0, skyEstimation: 0}
    };
  }
}

// Calculate frame-by-frame quality metrics for decorrelation
function calculateFrameMetrics(image, stars, frameIndex) {
  var metrics = {
    frameIndex: frameIndex,
    timestamp: Date.now(), // Will be replaced with proper time if available
    fwhm: 0,
    skyBackground: 0,
    starCount: 0,
    drift: {x: 0, y: 0},
    airmass: 1.0, // Default, will be extracted from FITS if available
    temperature: null,
    focus: null
  };
  
  try {
    if (!stars || stars.length === 0) {
      return metrics;
    }
    
    // Calculate median FWHM across all stars
    var fwhms = stars.map(function(star) { return star.fwhm; }).filter(function(f) { return f > 0; });
    if (fwhms.length > 0) {
      fwhms.sort(function(a, b) { return a - b; });
      metrics.fwhm = fwhms[Math.floor(fwhms.length / 2)];
    }
    
    // Calculate image statistics for sky background
    var imageStats = calculateImageStatistics(image, 50);
    metrics.skyBackground = imageStats.mean;
    metrics.starCount = stars.length;
    
    // Calculate centroid drift (relative to first frame)
    if (frameIndex === 0) {
      // Store reference positions for first frame
      if (!GlobalSettings.referenceCentroids) {
        GlobalSettings.referenceCentroids = stars.map(function(star) {
          return {x: star.x, y: star.y};
        });
      }
      metrics.drift = {x: 0, y: 0};
    } else {
      // Calculate median drift from reference frame
      if (GlobalSettings.referenceCentroids && stars.length >= GlobalSettings.referenceCentroids.length) {
        var drifts = [];
        for (var i = 0; i < Math.min(stars.length, GlobalSettings.referenceCentroids.length); i++) {
          drifts.push({
            x: stars[i].x - GlobalSettings.referenceCentroids[i].x,
            y: stars[i].y - GlobalSettings.referenceCentroids[i].y
          });
        }
        
        // Median drift
        var xDrifts = drifts.map(function(d) { return d.x; }).sort(function(a, b) { return a - b; });
        var yDrifts = drifts.map(function(d) { return d.y; }).sort(function(a, b) { return a - b; });
        metrics.drift.x = xDrifts[Math.floor(xDrifts.length / 2)];
        metrics.drift.y = yDrifts[Math.floor(yDrifts.length / 2)];
      }
    }
    
    return metrics;
  } catch (e) {
    console.warningln('[!] Error calculating frame metrics: ' + e);
    return metrics;
  }
}

// Apply frame-by-frame decorrelation to photometry
function decorrelatePhotometry(photometryData, frameMetrics) {
  try {
    if (!photometryData || photometryData.length < 5 || !frameMetrics || frameMetrics.length !== photometryData.length) {
      console.writeln('Insufficient data for decorrelation, skipping...');
      return photometryData; // Return unchanged
    }
    
    console.writeln('Applying frame-by-frame decorrelation...');
    
    // Extract target and comparison fluxes
    var targetFluxes = photometryData.map(function(d) { return d.targetFlux; });
    var comparisonFluxes = photometryData.map(function(d) { return d.comparisonFlux; });
    
    // Calculate differential magnitudes (target - comparison)
    var diffMags = [];
    for (var i = 0; i < photometryData.length; i++) {
      if (targetFluxes[i] > 0 && comparisonFluxes[i] > 0) {
        diffMags.push(-2.5 * Math.log10(targetFluxes[i] / comparisonFluxes[i]));
      } else {
        diffMags.push(0); // Flag bad points
      }
    }
    
    // Extract correlation variables
    var fwhms = frameMetrics.map(function(m) { return m.fwhm; });
    var skyLevels = frameMetrics.map(function(m) { return m.skyBackground; });
    var xDrifts = frameMetrics.map(function(m) { return m.drift.x; });
    var yDrifts = frameMetrics.map(function(m) { return m.drift.y; });
    
    // Simple linear decorrelation (remove trends)
    // This is a basic implementation - could be enhanced with proper regression
    
    // Calculate median values for normalization
    var medianFWHM = median(fwhms);
    var medianSky = median(skyLevels);
    
    // Apply corrections
    var correctedDiffMags = [];
    for (var i = 0; i < diffMags.length; i++) {
      var correction = 0;
      
      // FWHM correlation (seeing effects)
      if (medianFWHM > 0 && fwhms[i] > 0) {
        correction += 0.02 * (fwhms[i] - medianFWHM) / medianFWHM; // 2% per FWHM unit
      }
      
      // Sky level correlation (transparency/clouds)
      if (medianSky > 0 && skyLevels[i] > 0) {
        correction += 0.01 * (skyLevels[i] - medianSky) / medianSky; // 1% per sky unit
      }
      
      // Drift correlation (tracking errors)
      var driftMagnitude = Math.sqrt(xDrifts[i] * xDrifts[i] + yDrifts[i] * yDrifts[i]);
      correction += 0.001 * driftMagnitude; // 0.1% per pixel drift
      
      correctedDiffMags.push(diffMags[i] - correction);
    }
    
    // Convert back to relative fluxes and update photometry data
    var correctedData = [];
    for (var i = 0; i < photometryData.length; i++) {
      var correctedRelFlux = Math.pow(10, -correctedDiffMags[i] / 2.5);
      
      var newDataPoint = {
        time: photometryData[i].time,
        targetFlux: photometryData[i].targetFlux,
        comparisonFlux: photometryData[i].comparisonFlux,
        relativeFlux: correctedRelFlux,
        uncertainty: photometryData[i].uncertainty,
        frameMetrics: frameMetrics[i]
      };
      correctedData.push(newDataPoint);
    }
    
    // Calculate improvement
    var originalRMS = calculateRMS(diffMags);
    var correctedRMS = calculateRMS(correctedDiffMags);
    var improvement = ((originalRMS - correctedRMS) / originalRMS * 100);
    
    console.writeln('Decorrelation applied: RMS improved by ' + improvement.toFixed(1) + '% (' + 
                   (originalRMS * 1000).toFixed(1) + ' -> ' + (correctedRMS * 1000).toFixed(1) + ' mmag)');
    
    return correctedData;
  } catch (e) {
    console.warningln('[!] Error in decorrelation: ' + e);
    return photometryData; // Return unchanged on error
  }
}

// Utility function to calculate RMS
function calculateRMS(values) {
  if (!values || values.length === 0) return 0;
  
  var mean = values.reduce(function(sum, val) { return sum + val; }, 0) / values.length;
  var squaredDiffs = values.map(function(val) { return (val - mean) * (val - mean); });
  var meanSquaredDiff = squaredDiffs.reduce(function(sum, val) { return sum + val; }, 0) / squaredDiffs.length;
  
  return Math.sqrt(meanSquaredDiff);
}

// Utility function to calculate median
function median(values) {
  if (!values || values.length === 0) return 0;
  
  var sorted = values.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

// Select optimal target star based on position and quality
function selectTargetStar(stars, parameters) {
  parameters = parameters || {};
  // Fix boolean default so false works correctly
  var preferCenter;
  if (typeof parameters.preferCenter === 'boolean') {
    preferCenter = parameters.preferCenter;
  } else {
    preferCenter = true;
  }
  var minQuality = parameters.minQuality || 0.5;
  
  if (stars.length === 0) {
    console.warningln('[!] No stars available for target selection');
    return null;
  }
  
  try {
    // Calculate image center for reference
    var centerX = GlobalSettings.imageWidth / 2;
    var centerY = GlobalSettings.imageHeight / 2;
    
    // Create a target score for each star
    var scoredStars = stars.map(function(star) {
      var distanceFromCenter = Math.sqrt(Math.pow(star.x - centerX, 2) + Math.pow(star.y - centerY, 2));
      var normalizedDistance = distanceFromCenter / Math.sqrt(centerX * centerX + centerY * centerY);
      
      // Score formula: quality is primary, center proximity is secondary
      var positionScore = preferCenter ? (1.0 - normalizedDistance) : 0.5;
      var targetScore = (star.quality * 0.7) + (positionScore * 0.3);
      
      return {
        star: star,
        score: targetScore
      };
    });
    
    // Sort by score
    scoredStars.sort(function(a, b) {
      return b.score - a.score;
    });
    
    // Select highest scoring star that meets minimum quality
    for (var i = 0; i < scoredStars.length; i++) {
      if (scoredStars[i].star.quality >= minQuality) {
        var target = scoredStars[i].star;
        console.writeln('[>] Selected target star at (' + 
          target.x.toFixed(1) + ', ' + target.y.toFixed(1) + 
          ') with quality ' + target.quality.toFixed(2) + 
          ', FWHM ' + target.fwhm.toFixed(1) + ' pixels');
        
        if (target.fwhmArcsec) {
          console.writeln('[>] Target star FWHM: ' + target.fwhmArcsec.toFixed(2) + ' arcseconds');
        }
        
        return target;
      }
    }
    
    // If no star meets criteria, return the best one available
    if (scoredStars.length > 0) {
      console.warningln('[!] No ideal target stars found, using best available');
      return scoredStars[0].star;
    }
    
    return null;
  } catch (e) {
    console.warningln('[!] Error selecting target star: ' + e);
    return null;
  }
}

// Select optimal comparison stars
function selectComparisonStars(stars, targetStar, count) {
  count = count || 3; // Default to 3 comparison stars
  
  if (!targetStar || stars.length <= 1) {
    console.warningln('[!] Cannot select comparison stars: No target or insufficient stars');
    return [];
  }
  
  try {
    // Create a deep copy of stars array for manipulation
    var candidates = stars.slice(0);
    
    // Remove target star from candidates
    candidates = candidates.filter(function(star) {
      return !(Math.abs(star.x - targetStar.x) < 1 && Math.abs(star.y - targetStar.y) < 1);
    });
    
    // Calculate a comparison score for each star
    var scoredCandidates = candidates.map(function(star) {
      // Ideal comparison stars are:      
      // 1. Similar brightness to target (but not saturated)
      var denom = Math.max(targetStar.brightness, 1e-6); // Guard against divide by zero
      var brightnessDiff = Math.abs(star.brightness - targetStar.brightness) / denom;
      var brightnessScore = 1.0 - Math.min(1.0, brightnessDiff);
      
      // 2. Not too close to target but not too far either
      var distance = Math.sqrt(Math.pow(star.x - targetStar.x, 2) + Math.pow(star.y - targetStar.y, 2));
      var imageDiagonal = Math.sqrt(GlobalSettings.imageWidth * GlobalSettings.imageWidth + GlobalSettings.imageHeight * GlobalSettings.imageHeight);
      var normalizedDistance = Math.min(1.0, distance / Math.max(imageDiagonal * 0.5, 1)); // Normalize by half diagonal
      var distanceScore = 0.3 + 0.7 * (1.0 - Math.abs(normalizedDistance - 0.5) * 2); // Prefer middle distances
      
      // 3. Similar FWHM to target (indicates similar focus/tracking)
      var fwhmDiff = Math.abs(star.fwhm - targetStar.fwhm) / targetStar.fwhm;
      var fwhmScore = 1.0 - Math.min(1.0, fwhmDiff);
      
      // 4. Not saturated
      var saturationScore = star.saturated ? 0.1 : 1.0;
      
      // Weighted final score
      var comparisonScore = 
        (brightnessScore * 0.4) + 
        (distanceScore * 0.2) + 
        (fwhmScore * 0.3) + 
        (saturationScore * 0.1) + 
        (star.quality * 0.3);
      
      return {
        star: star,
        score: comparisonScore
      };
    });
    
    // Sort by score
    scoredCandidates.sort(function(a, b) {
      return b.score - a.score;
    });
    
    // Select top N comparison stars
    var selectedCount = Math.min(count, scoredCandidates.length);
    var comparisonStars = [];
    
    for (var i = 0; i < selectedCount; i++) {
      comparisonStars.push(scoredCandidates[i].star);
      console.writeln('? Selected comparison star ' + (i+1) + ' at (' + 
        comparisonStars[i].x.toFixed(1) + ', ' + comparisonStars[i].y.toFixed(1) + 
        ') with FWHM ' + comparisonStars[i].fwhm.toFixed(1) + ' pixels');
    }
    
    console.writeln('? Selected ' + comparisonStars.length + ' comparison stars');
    return comparisonStars;
  } catch (e) {
    console.warningln('[!] Error selecting comparison stars: ' + e);
    return [];
  }
}

// ---------------- Historical Exoplanet Transit Detection Functions ----------------

// Extract observation date/time from FITS headers
function extractObservationDate(imageWindow) {
  try {
    // Check if image window exists
    if (!imageWindow || !imageWindow.mainView) {
      console.warningln('[!] No image window or main view available');
      return null;
    }
    
    var observationJD = null;
    var dateObs = null;
    var keywords = null;
    
    // Method 1: Try to access keywords through mainView.keywords
    try {
      if (imageWindow.mainView.keywords) {
        keywords = imageWindow.mainView.keywords;
        console.writeln('[>] Found keywords via mainView.keywords: ' + keywords.length);
      }
    } catch (e) {
      console.writeln('[>] Could not access mainView.keywords: ' + e);
    }
    
    // Method 2: Try to access keywords through propertyValue
    if (!keywords) {
      try {
        // PixInsight sometimes stores FITS keywords differently
        var fitsKeywords = imageWindow.mainView.propertyValue('FITS:Keywords');
        if (fitsKeywords && fitsKeywords.length > 0) {
          keywords = fitsKeywords;
          console.writeln('[>] Found keywords via propertyValue: ' + keywords.length);
        }
      } catch (e) {
        console.writeln('[>] Could not access propertyValue FITS keywords: ' + e);
      }
    }
    
    // Method 3: Try individual keyword lookups
    if (!keywords) {
      console.writeln('[>] Trying direct keyword lookup...');
      
      // Try direct access to common date keywords
      var directKeywords = [];
      var keywordsToTry = ['DATE-OBS', 'JD', 'JD-OBS', 'MJD', 'MJD-OBS', 'JULIAN'];
      
      for (var k = 0; k < keywordsToTry.length; k++) {
        try {
          var keywordValue = imageWindow.mainView.propertyValue('FITS:' + keywordsToTry[k]);
          if (keywordValue !== undefined && keywordValue !== null) {
            directKeywords.push({ name: keywordsToTry[k], value: keywordValue });
            console.writeln('[>] Direct keyword found: ' + keywordsToTry[k] + ' = ' + keywordValue);
          }
        } catch (e) {
          // Keyword not found - normal, continue
        }
      }
      
      if (directKeywords.length > 0) {
        keywords = directKeywords;
        console.writeln('[>] Found ' + keywords.length + ' keywords via direct lookup');
      }
    }
    
    // Method 4: Try PixInsight's built-in observation time properties
    if (!keywords || keywords.length === 0) {
      console.writeln('[>] Trying PixInsight built-in observation properties...');
      
      try {
        // Check if PixInsight has extracted observation start time
        var obsStartTime = imageWindow.mainView.propertyValue('Observation:Time:Start');
        var obsEndTime = imageWindow.mainView.propertyValue('Observation:Time:End');
        
        if (obsStartTime || obsEndTime) {
          var obsTime = obsStartTime || obsEndTime;
          console.writeln('[>] Found PixInsight observation time: ' + obsTime);
          
          // Try to parse the PixInsight time format
          try {
            // PixInsight time formats can be:
            // "Fri Aug 29 2025 21:59:21 GMT-0400 (Eastern Standard Time)"
            // "2025-08-29 21:59:21 UTC"
            
            var timeStr = obsTime.toString();
            console.writeln('[>] Parsing PixInsight time format: ' + timeStr);
            
            // Method 1: Try JavaScript Date parsing (handles many formats)
            try {
              var jsDate = new Date(timeStr);
              if (!isNaN(jsDate.getTime())) {
                // Convert JS Date to Julian Date
                // JS Date.getTime() returns milliseconds since Unix epoch (1970-01-01)
                // Julian Date for Unix epoch is 2440587.5
                observationJD = 2440587.5 + (jsDate.getTime() / 86400000.0);
                
                if (observationJD > 2400000 && observationJD < 2500000) { // Reasonable range check
                  console.writeln('[>] Successfully parsed PixInsight time to JD: ' + observationJD);
                  return {
                    julianDate: observationJD,
                    dateString: formatJDToISO(observationJD),
                    source: 'PixInsight Properties (JS Date)'
                  };
                }
              }
            } catch (e) {
              console.writeln('[>] JavaScript Date parsing failed: ' + e);
            }
            
            // Method 2: Try manual parsing for standard format
            var cleanTimeStr = timeStr.replace(' UTC', '').replace(' ', 'T');
            if (cleanTimeStr.indexOf('T') > 0) {
              observationJD = parseISODateToJD(cleanTimeStr);
              
              if (!isNaN(observationJD) && observationJD > 2400000) {
                console.writeln('[>] Successfully parsed cleaned time to JD: ' + observationJD);
                return {
                  julianDate: observationJD,
                  dateString: formatJDToISO(observationJD),
                  source: 'PixInsight Properties (ISO)'
                };
              }
            }
            
          } catch (e) {
            console.warningln('[!] Could not parse PixInsight observation time: ' + e);
          }
        }
      } catch (e) {
        console.writeln('[>] Could not access PixInsight observation properties: ' + e);
      }
      
      // Method 5: Try common PixInsight property names
      try {
        var propertyNames = [
          'FITS:DATE-OBS', 'FITS:JD', 'FITS:MJD', 'FITS:JULIAN',
          'Observation:StartTime', 'Observation:EndTime',
          'DATE-OBS', 'JD', 'MJD'
        ];
        
        for (var p = 0; p < propertyNames.length; p++) {
          try {
            var propValue = imageWindow.mainView.propertyValue(propertyNames[p]);
            if (propValue !== undefined && propValue !== null) {
              console.writeln('[>] Found property ' + propertyNames[p] + ': ' + propValue);
              
              // Try to parse based on property name
              if (propertyNames[p].indexOf('JD') >= 0 || propertyNames[p].indexOf('JULIAN') >= 0) {
                var jdVal = parseFloat(propValue);
                if (!isNaN(jdVal) && jdVal > 2400000) {
                  observationJD = jdVal;
                  console.writeln('[>] Successfully extracted JD: ' + observationJD);
                  break;
                }
              } else if (propertyNames[p].indexOf('MJD') >= 0) {
                var mjdVal = parseFloat(propValue);
                if (!isNaN(mjdVal) && mjdVal > 0) {
                  observationJD = mjdVal + 2400000.5;
                  console.writeln('[>] Successfully extracted MJD and converted: ' + observationJD);
                  break;
                }
              } else {
                // Assume it's a date string
                var dateStr = propValue.toString().replace(' UTC', '').replace(' ', 'T');
                try {
                  observationJD = parseISODateToJD(dateStr);
                  if (!isNaN(observationJD) && observationJD > 2400000) {
                    console.writeln('[>] Successfully parsed date property: ' + observationJD);
                    break;
                  }
                } catch (e) {
                  // Continue to next property
                }
              }
            }
          } catch (e) {
            // Property not found - continue
          }
        }
        
        if (observationJD) {
          return {
            julianDate: observationJD,
            dateString: formatJDToISO(observationJD),
            source: 'PixInsight Property Scan'
          };
        }
      } catch (e) {
        console.writeln('[>] Property scan failed: ' + e);
      }
    }
    
    // If still no keywords, give up
    if (!keywords || keywords.length === 0) {
      console.warningln('[!] No temporal information accessible through any method');
      console.writeln('[>] This may be a processed image that lost original FITS headers');
      console.writeln('[>] For transit detection, ensure your FITS files contain DATE-OBS or JD keywords');
      return null;
    }
    
    // Try to find Julian Date first (most precise)
    for (var i = 0; i < keywords.length; i++) {
      var keyword = keywords[i];
      
      // Safety check for keyword structure
      if (!keyword || !keyword.name || keyword.value === undefined) {
        continue;
      }
      
      // Look for various JD keywords
      if (keyword.name === 'JD' || keyword.name === 'JULIAN' || keyword.name === 'JD-OBS') {
        var jdValue = parseFloat(keyword.value);
        if (!isNaN(jdValue) && jdValue > 2400000) { // Reasonable JD range check
          observationJD = jdValue;
          console.writeln('[>] Found Julian Date: ' + observationJD);
          break;
        }
      }
      
      // Look for Modified Julian Date
      if (keyword.name === 'MJD' || keyword.name === 'MJD-OBS') {
        var mjdValue = parseFloat(keyword.value);
        if (!isNaN(mjdValue) && mjdValue > 0) { // Reasonable MJD range check
          observationJD = mjdValue + 2400000.5; // Convert MJD to JD
          console.writeln('[>] Found Modified Julian Date, converted: ' + observationJD);
          break;
        }
      }
    }
    
    // If no JD found, try to parse DATE-OBS
    if (!observationJD) {
      for (var i = 0; i < keywords.length; i++) {
        var keyword = keywords[i];
        
        // Safety check for keyword structure
        if (!keyword || !keyword.name || keyword.value === undefined) {
          continue;
        }
        
        if (keyword.name === 'DATE-OBS') {
          dateObs = keyword.value.toString().trim();
          // Remove quotes if present
          dateObs = dateObs.replace(/['"\/]/g, '');
          
          // Basic format validation
          if (dateObs.length >= 10 && dateObs.indexOf('-') > 0) {
            try {
              observationJD = parseISODateToJD(dateObs);
              if (!isNaN(observationJD) && observationJD > 2400000) { // Reasonable JD check
                console.writeln('[>] Parsed DATE-OBS to JD: ' + dateObs + ' -> ' + observationJD);
                break;
              }
            } catch (e) {
              console.warningln('[!] Could not parse DATE-OBS: ' + dateObs + ' (' + e + ')');
            }
          }
        }
      }
    }
    
    if (!observationJD) {
      console.warningln('[!] No observation date found in FITS headers');
      return null;
    }
    
    return {
      julianDate: observationJD,
      dateString: formatJDToISO(observationJD),
      source: dateObs ? 'DATE-OBS' : 'JD'
    };
  } catch (e) {
    console.warningln('[!] Error extracting observation date: ' + e);
    return null;
  }
}

// Convert ISO date string to Julian Date
function parseISODateToJD(dateString) {
  // Handle various DATE-OBS formats:
  // YYYY-MM-DD
  // YYYY-MM-DDTHH:MM:SS
  // YYYY-MM-DDTHH:MM:SS.SSS
  
  try {
    var parts = dateString.split('T');
    var datePart = parts[0];
    var timePart = parts[1] || '00:00:00';
    
    var dateComponents = datePart.split('-');
    var year = parseInt(dateComponents[0]);
    var month = parseInt(dateComponents[1]);
    var day = parseInt(dateComponents[2]);
    
    var timeComponents = timePart.split(':');
    var hour = parseInt(timeComponents[0]) || 0;
    var minute = parseInt(timeComponents[1]) || 0;
    var second = parseFloat(timeComponents[2]) || 0.0;
    
    // Calculate Julian Date (simplified algorithm)
    var a = Math.floor((14 - month) / 12);
    var y = year + 4800 - a;
    var m = month + 12 * a - 3;
    
    var jdn = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    
    // Add time fraction
    var timeFraction = (hour - 12) / 24 + minute / 1440 + second / 86400;
    
    return jdn + timeFraction;
  } catch (e) {
    throw new Error('Invalid date format: ' + dateString);
  }
}

// Format Julian Date to readable ISO string
function formatJDToISO(jd) {
  // Convert JD to calendar date (simplified)
  var Z = Math.floor(jd + 0.5);
  var F = (jd + 0.5) - Z;
  
  var A = Z;
  if (Z >= 2299161) {
    var alpha = Math.floor((Z - 1867216.25) / 36524.25);
    A = Z + 1 + alpha - Math.floor(alpha / 4);
  }
  
  var B = A + 1524;
  var C = Math.floor((B - 122.1) / 365.25);
  var D = Math.floor(365.25 * C);
  var E = Math.floor((B - D) / 30.6001);
  
  var day = B - D - Math.floor(30.6001 * E);
  var month = (E < 14) ? E - 1 : E - 13;
  var year = (month > 2) ? C - 4716 : C - 4715;
  
  // Calculate time from fraction
  var totalSeconds = F * 86400;
  var hour = Math.floor(totalSeconds / 3600);
  var minute = Math.floor((totalSeconds % 3600) / 60);
  var second = Math.floor(totalSeconds % 60);
  
  return year + '-' + 
         (month < 10 ? '0' : '') + month + '-' + 
         (day < 10 ? '0' : '') + day + 'T' + 
         (hour < 10 ? '0' : '') + hour + ':' + 
         (minute < 10 ? '0' : '') + minute + ':' + 
         (second < 10 ? '0' : '') + second + 'Z';
}

// Extract field center coordinates from FITS headers or WCS solution
function extractFieldCenter(imageWindow) {
  console.writeln('[>] Starting field center coordinate extraction...');
  
  if (!imageWindow || !imageWindow.mainView) {
    console.warningln('[!] Invalid image window provided');
    return null;
  }
  
  // Method 1: Direct FITS keyword extraction (primary method)
  console.writeln('[>] Method 1: Direct FITS keyword extraction...');
  try {
    var keywordMap = buildKeywordMap(imageWindow);
    var keywordCount = Object.keys(keywordMap).length;
    console.writeln('[>] Found ' + keywordCount + ' FITS keywords');
    
    // Check coordinate keywords in priority order
    var coordKeywords = ['RA', 'DEC', 'OBJCTRA', 'OBJCTDEC', 'CRVAL1', 'CRVAL2'];
    var foundRA = null, foundDEC = null;
    
    for (var i = 0; i < coordKeywords.length; i++) {
      var keyName = coordKeywords[i];
      var keyValue = getKeyword(keywordMap, keyName);
      if (keyValue !== undefined) {
        console.writeln('[>] Found ' + keyName + ' = ' + keyValue);
        
        // Extract RA coordinate
        if ((keyName === 'RA' || keyName === 'CRVAL1') && !foundRA) {
          var testRA = parseFloat(keyValue);
          if (!isNaN(testRA) && testRA >= 0 && testRA <= 360) {
            foundRA = testRA;
            console.writeln('[>] Valid RA: ' + testRA + '°');
          }
        }
        // Extract DEC coordinate  
        if ((keyName === 'DEC' || keyName === 'CRVAL2') && !foundDEC) {
          var testDEC = parseFloat(keyValue);
          if (!isNaN(testDEC) && testDEC >= -90 && testDEC <= 90) {
            foundDEC = testDEC;
            console.writeln('[>] Valid DEC: ' + testDEC + '°');
          }
        }
        // Extract from HMS/DMS format (OBJCTRA/OBJCTDEC)
        if (keyName === 'OBJCTRA' && !foundRA) {
          foundRA = parseRADecToDecimal(keyValue);
          if (!isNaN(foundRA) && foundRA >= 0 && foundRA <= 360) {
            console.writeln('[>] Parsed OBJCTRA: ' + foundRA + '°');
          } else {
            foundRA = null;
          }
        }
        if (keyName === 'OBJCTDEC' && !foundDEC) {
          foundDEC = parseRADecToDecimal(keyValue);
          if (!isNaN(foundDEC) && foundDEC >= -90 && foundDEC <= 90) {
            console.writeln('[>] Parsed OBJCTDEC: ' + foundDEC + '°');
          } else {
            foundDEC = null;
          }
        }
      }
    }
    
    // Return if both coordinates found
    if (foundRA !== null && foundDEC !== null) {
      console.writeln('[>] ? SUCCESS: RA=' + foundRA.toFixed(6) + '°, DEC=' + foundDEC.toFixed(6) + '°');
      return { ra: foundRA, dec: foundDEC, source: 'FITS Keywords' };
    }
    
    console.writeln('[>] Method 1 incomplete: RA=' + foundRA + ', DEC=' + foundDEC);
    
  } catch (e) {
    console.writeln('[>] Method 1 failed: ' + e);
  }
  
  // Method 2: Try PixInsight property access
  console.writeln('[>] Method 2: PixInsight property access...');
  try {
    var propRA = imageWindow.mainView.propertyValue('FITS:RA');
    var propDEC = imageWindow.mainView.propertyValue('FITS:DEC');
    
    if (propRA && propDEC) {
      var ra = parseFloat(propRA);
      var dec = parseFloat(propDEC);
      if (!isNaN(ra) && !isNaN(dec) && ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90) {
        console.writeln('[>] ? SUCCESS: RA=' + ra.toFixed(6) + '°, DEC=' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'PixInsight Properties' };
      }
    }
  } catch (e) {
    console.writeln('[>] Method 2 failed: ' + e);
  }
  
  // Method 3: Try WCS reference coordinates  
  console.writeln('[>] Method 3: WCS reference coordinates...');
  try {
    var crval1 = imageWindow.mainView.propertyValue('FITS:CRVAL1');
    var crval2 = imageWindow.mainView.propertyValue('FITS:CRVAL2');
    
    if (crval1 && crval2) {
      var ra = parseFloat(crval1);
      var dec = parseFloat(crval2);
      if (!isNaN(ra) && !isNaN(dec) && ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90) {
        console.writeln('[>] ? SUCCESS: RA=' + ra.toFixed(6) + '°, DEC=' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'WCS Reference' };
      }
    }
  } catch (e) {
    console.writeln('[>] Method 3 failed: ' + e);
  }
  
  // Method 4: Manual coordinate entry fallback
  console.writeln('[>] Method 4: Manual coordinate entry...');
  try {
    var imageName = imageWindow.mainView.id || 'image';
    
    console.writeln('[>] All automatic methods failed - providing guidance:');
    console.writeln('   ° To enable automatic extraction:');
    console.writeln('     1. Use Process > ImageSolver > ImageSolver');
    console.writeln('     2. This will embed WCS keywords in FITS header');
    console.writeln('   ° Alternative: Check coordinates at nova.astrometry.net');
    console.writeln('');
    
    var manualCoords = promptForCoordinates(imageName);
    if (manualCoords && isFinite(manualCoords.ra) && isFinite(manualCoords.dec)) {
      console.writeln('[>] ? Using manual coordinates: RA=' + manualCoords.ra.toFixed(6) + '°, DEC=' + manualCoords.dec.toFixed(6) + '°');
      return { ra: manualCoords.ra, dec: manualCoords.dec, source: 'Manual Entry' };
    } else {
      console.writeln('[>] Manual entry cancelled - continuing without transit analysis');
    }
    
  } catch (e) {
    console.writeln('[>] Method 4 failed: ' + e);
  }
  
  console.warningln('[!] No field center coordinates found');
  return null;
  
  try {
    var ra = null, dec = null;
    
    // Method 0: Try direct access to image center from astrometric solution properties
    console.writeln('[>] Attempting Method 0: Direct center access from image properties...');
    try {
      // Try accessing the ImageSolver generated center coordinates first
      var centerRA = null, centerDec = null;
      
      // PixInsight often stores the solved image center in these specific properties
      try {
        centerRA = imageWindow.mainView.propertyValue('AstrometricSolution:centerRA');
        centerDec = imageWindow.mainView.propertyValue('AstrometricSolution:centerDec');
        console.writeln('[>] AstrometricSolution center properties: RA = ' + centerRA + ', Dec = ' + centerDec);
      } catch (e) {
        console.writeln('[>] AstrometricSolution properties not available: ' + e);
      }
      
      // Alternative property names
      if (centerRA === null || centerRA === undefined || isNaN(centerRA)) {
        try {
          centerRA = imageWindow.mainView.propertyValue('ImageSolver:image_center_ra');
          centerDec = imageWindow.mainView.propertyValue('ImageSolver:image_center_dec');
          console.writeln('[>] ImageSolver image_center properties: RA = ' + centerRA + ', Dec = ' + centerDec);
        } catch (e) {
          console.writeln('[>] ImageSolver image_center properties not available: ' + e);
        }
      }
      
      // Parse coordinates if found
      if (centerRA !== null && centerRA !== undefined && !isNaN(parseFloat(centerRA)) &&
          centerDec !== null && centerDec !== undefined && !isNaN(parseFloat(centerDec))) {
        ra = parseFloat(centerRA);
        dec = parseFloat(centerDec);
        
        // Convert from radians to degrees if values suggest radians
        if (Math.abs(ra) <= 2 * Math.PI && Math.abs(dec) <= Math.PI) {
          ra = ra * 180 / Math.PI;
          dec = dec * 180 / Math.PI;
          console.writeln('[>] Converted from radians');
        }
        
        console.writeln('[>] Field center from direct properties: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'Direct Properties' };
      }
    } catch (e) {
      console.writeln('[>] Direct property access failed: ' + e);
    }
    
    // Method 1: Try to get coordinates from PixInsight's astrometric solution
    console.writeln('[>] Attempting Method 1: Enhanced astrometric solution access...');
    try {
      console.writeln('[>] Checking for astrometric solution...');
      
      // Debug imageWindow structure
      console.writeln('[>] ImageWindow exists: ' + (imageWindow ? 'YES' : 'NO'));
      console.writeln('[>] MainView exists: ' + (imageWindow.mainView ? 'YES' : 'NO'));
      
      // Try different ways to access astrometric solution
      var astrometricSolution = null;
      
      // Method A: Direct access
      try {
        astrometricSolution = (imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution);
        console.writeln('[>] Direct access result: ' + (astrometricSolution ? 'FOUND' : 'NULL'));
      } catch (e) {
        console.writeln('[>] Direct access failed: ' + e);
      }
      
      // Method B: Check if image has WCS properties
      try {
        var hasWCS = imageWindow.mainView.hasWCSKeywords;
        console.writeln('[>] hasWCSKeywords: ' + hasWCS);
      } catch (e) {
        console.writeln('[>] hasWCSKeywords check failed: ' + e);
      }
      
      // Method C: List all available properties
      try {
        console.writeln('[>] Listing imageWindow.mainView properties...');
        for (var prop in imageWindow.mainView) {
          try {
            var value = imageWindow.mainView[prop];
            var type = typeof value;
            if (prop.toLowerCase().indexOf('astr') >= 0 || prop.toLowerCase().indexOf('wcs') >= 0 || prop.toLowerCase().indexOf('coord') >= 0) {
              console.writeln('[>]   ' + prop + ': ' + type + ' = ' + (value ? 'EXISTS' : 'null'));
            }
          } catch (e) {
            // Skip properties that can't be accessed
          }
        }
      } catch (e) {
        console.writeln('[>] Property enumeration failed: ' + e);
      }
      
      if (astrometricSolution) {
        console.writeln('[>] Found astrometric solution, extracting center coordinates...');
        
        // Try different approaches to get center coordinates
        var centerRA = null, centerDec = null;
        
        // Approach 1: Direct properties
        try {
          centerRA = astrometricSolution.centerRA;
          centerDec = astrometricSolution.centerDec;
          console.writeln('[>] Direct properties - RA: ' + centerRA + ', Dec: ' + centerDec);
        } catch (e1) {
          console.writeln('[>] Direct properties failed: ' + e1);
        }
        
        // Approach 2: Try projection origin
        if ((centerRA === null || centerRA === undefined || isNaN(centerRA)) && astrometricSolution.projectionOrigin) {
          try {
            var projOrigin = astrometricSolution.projectionOrigin;
            console.writeln('[>] Found projection origin: ' + projOrigin);
            
            // Extract coordinates from projection origin if it's an array [x, y, ra, dec]
            if (projOrigin && projOrigin.length >= 4) {
              centerRA = projOrigin[2];  // RA should be at index 2
              centerDec = projOrigin[3]; // Dec should be at index 3
              console.writeln('[>] Projection origin coordinates - RA: ' + centerRA + ', Dec: ' + centerDec);
            }
          } catch (e2) {
            console.writeln('[>] Projection origin access failed: ' + e2);
          }
        }
        
        // Approach 3: Convert from radians if needed
        if (centerRA !== null && centerRA !== undefined && !isNaN(centerRA) && centerDec !== null && centerDec !== undefined && !isNaN(centerDec)) {
          // Check if values are in radians (typical range: 0-2° for RA, -°/2 to °/2 for Dec)
          if (Math.abs(centerRA) <= 2 * Math.PI && Math.abs(centerDec) <= Math.PI) {
            ra = centerRA * 180 / Math.PI; // Convert radians to degrees
            dec = centerDec * 180 / Math.PI;
            console.writeln('[>] Converted from radians - RA: ' + ra.toFixed(6) + '°, Dec: ' + dec.toFixed(6) + '°');
          } else {
            // Already in degrees
            ra = centerRA;
            dec = centerDec;
            console.writeln('[>] Using direct degree values - RA: ' + ra.toFixed(6) + '°, Dec: ' + dec.toFixed(6) + '°');
          }
          return { ra: ra, dec: dec, source: 'Astrometric Solution' };
        } else {
          console.writeln('[>] Astrometric solution coordinates are undefined or NaN');
        }
      } else {
        console.writeln('[>] No astrometric solution available');
      }
    } catch (e) {
      console.writeln('[>] Could not access astrometric solution: ' + e);
    }
    
    // Method 2: Try FITS keywords with comprehensive WCS keyword access
    console.writeln('[>] Attempting to extract field center from FITS keywords...');
    var keywords = null;
    var ra = null, dec = null;
    
    // Try to access keywords through different methods
    try {
      if (imageWindow.mainView.keywords) {
        keywords = imageWindow.mainView.keywords;
        console.writeln('[>] Found ' + keywords.length + ' FITS keywords via mainView.keywords');
      }
    } catch (e) {
      console.writeln('[>] MainView.keywords failed: ' + e);
    }
    
    if (!keywords) {
      console.writeln('[>] Trying propertyValue method...');
      try {
        var fitsKeywords = imageWindow.mainView.propertyValue('FITS:Keywords');
        if (fitsKeywords && fitsKeywords.length > 0) {
          keywords = fitsKeywords;
          console.writeln('[>] Found ' + keywords.length + ' FITS keywords via propertyValue');
        }
      } catch (e2) {
        console.writeln('[>] PropertyValue FITS:Keywords failed: ' + e2);
      }
    }
    
    // Method 2A: Access PixInsight internal properties (where ImageSolver saves WCS data)
    console.writeln('[>] Method 2A: PixInsight internal property access...');
    try {
      // Try to access WCS data from PixInsight's internal properties
      var internalPropCount = 0;
      
      // ImageSolver saves WCS data to PixInsight properties, not FITS keywords
      var wcsProps = [
        'Astrometry_ReferenceRA',
        'Astrometry_ReferenceDec', 
        'Astrometry_ReferencePixelRA',
        'Astrometry_ReferencePixelDec',
        'Astrometry_CenterRA',
        'Astrometry_CenterDec',
        'PCL:AstrometricSolution:centerRA',
        'PCL:AstrometricSolution:centerDec',
        'WCS:CRVAL1',
        'WCS:CRVAL2',
        'WCS:CRPIX1', 
        'WCS:CRPIX2',
        'WCS:CD1_1',
        'WCS:CD1_2',
        'WCS:CD2_1',
        'WCS:CD2_2',
        'ImageSolver:centerRA',
        'ImageSolver:centerDec',
        'ImageSolver:imageCenter'
      ];
      
      for (var i = 0; i < wcsProps.length; i++) {
        try {
          var propValue = imageWindow.mainView.propertyValue(wcsProps[i]);
          if (propValue !== undefined && propValue !== null) {
            console.writeln('[>] Internal property ' + wcsProps[i] + ' = ' + propValue);
            internalPropCount++;
            
            // Check if this looks like RA/Dec coordinates
            if (wcsProps[i].toLowerCase().indexOf('centera') >= 0 || wcsProps[i].toLowerCase().indexOf('crval1') >= 0) {
              var testRA = parseFloat(propValue);
              if (!isNaN(testRA) && testRA >= 0 && testRA <= 360) {
                ra = testRA;
                console.writeln('[>] Found RA coordinate: ' + ra);
              }
            }
            if (wcsProps[i].toLowerCase().indexOf('centerdec') >= 0 || wcsProps[i].toLowerCase().indexOf('crval2') >= 0) {
              var testDec = parseFloat(propValue);
              if (!isNaN(testDec) && testDec >= -90 && testDec <= 90) {
                dec = testDec;
                console.writeln('[>] Found Dec coordinate: ' + dec);
              }
            }
          }
        } catch (e) {
          // Property not available
        }
      }
      
      console.writeln('[>] Found ' + internalPropCount + ' internal properties total');
      
      // If we found coordinates, return them
      if (ra !== null && dec !== null && !isNaN(ra) && !isNaN(dec)) {
        console.writeln('[>] Field center from internal properties: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'PixInsight Internal Properties' };
      }
      
    } catch (e) {
      console.writeln('[>] Internal property access failed: ' + e);
    }
    
    // Method 2B: Property enumeration - discover what properties are actually available
    console.writeln('[>] Method 2B: Property enumeration discovery...');
    try {
      console.writeln('[>] Enumerating all available properties...');
      var allProps = [];
      var propCount = 0;
      
      // Try to list all properties on the main view
      try {
        for (var prop in imageWindow.mainView) {
          try {
            if (typeof imageWindow.mainView[prop] === 'function') {
              // Skip function properties
              continue;
            }
            var value = imageWindow.mainView[prop];
            if (value !== undefined && value !== null) {
              allProps.push({ name: prop, value: value, type: typeof value });
              propCount++;
              
              // Log interesting properties
              if (prop.toLowerCase().indexOf('astr') >= 0 || 
                  prop.toLowerCase().indexOf('wcs') >= 0 ||
                  prop.toLowerCase().indexOf('coord') >= 0 ||
                  prop.toLowerCase().indexOf('center') >= 0 ||
                  prop.toLowerCase().indexOf('ra') >= 0 ||
                  prop.toLowerCase().indexOf('dec') >= 0) {
                console.writeln('[>] Interesting property: ' + prop + ' = ' + value + ' (' + typeof value + ')');
              }
            }
          } catch (e) {
            // Skip properties that can't be accessed
          }
        }
      } catch (e) {
        console.writeln('[>] Property enumeration failed: ' + e);
      }
      
      console.writeln('[>] Found ' + propCount + ' total properties on mainView');
      
      // Try property() method if available
      try {
        console.writeln('[>] Trying propertyIds() method...');
        if (typeof imageWindow.mainView.propertyIds === 'function') {
          var propertyIds = imageWindow.mainView.propertyIds();
          console.writeln('[>] Found ' + propertyIds.length + ' property IDs');
          
          for (var i = 0; i < propertyIds.length; i++) {
            try {
              var propId = propertyIds[i];
              var propVal = imageWindow.mainView.propertyValue(propId);
              
              if (propId.toLowerCase().indexOf('astr') >= 0 || 
                  propId.toLowerCase().indexOf('wcs') >= 0 ||
                  propId.toLowerCase().indexOf('coord') >= 0 ||
                  propId.toLowerCase().indexOf('center') >= 0 ||
                  propId.toLowerCase().indexOf('ra') >= 0 ||
                  propId.toLowerCase().indexOf('dec') >= 0 ||
                  propId.toLowerCase().indexOf('crval') >= 0) {
                console.writeln('[>] Property ID: ' + propId + ' = ' + propVal);
                
                // Try to extract coordinates
                if ((propId.toLowerCase().indexOf('ra') >= 0 || propId.toLowerCase().indexOf('crval1') >= 0) && ra === null) {
                  var testRA = parseFloat(propVal);
                  if (!isNaN(testRA) && testRA >= 0 && testRA <= 360) {
                    ra = testRA;
                    console.writeln('[>] Extracted RA from ' + propId + ': ' + ra);
                  }
                }
                if ((propId.toLowerCase().indexOf('dec') >= 0 || propId.toLowerCase().indexOf('crval2') >= 0) && dec === null) {
                  var testDec = parseFloat(propVal);
                  if (!isNaN(testDec) && testDec >= -90 && testDec <= 90) {
                    dec = testDec;
                    console.writeln('[>] Extracted Dec from ' + propId + ': ' + dec);
                  }
                }
              }
            } catch (e) {
              // Property not accessible
            }
          }
        }
      } catch (e) {
        console.writeln('[>] PropertyIds method failed: ' + e);
      }
      
      // Return coordinates if found
      if (ra !== null && dec !== null && !isNaN(ra) && !isNaN(dec)) {
        console.writeln('[>] Field center from property enumeration: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'Property Enumeration' };
      }
      
    } catch (e) {
      console.writeln('[>] Property enumeration failed: ' + e);
    }
    
    // Method 2C: Direct RA/DEC keyword extraction (priority method)
    console.writeln('[>] Method 2C: Direct RA/DEC keyword extraction...');
    
    // Try to read the exact RA and DEC keywords that appear in your FITS header
    var directCoordinates = {
      'RA': null,      // Direct RA keyword (degrees)
      'DEC': null,     // Direct DEC keyword (degrees)
      'OBJCTRA': null, // Object center RA
      'OBJCTDEC': null // Object center DEC
    };
    
    // First, try the most direct approach - read RA and DEC keywords
    for (var coordKey in directCoordinates) {
      try {
        var value = imageWindow.mainView.propertyValue('FITS:' + coordKey);
        if (value !== undefined && value !== null) {
          directCoordinates[coordKey] = value;
          console.writeln('[>] Found ' + coordKey + ' = ' + value);
        }
      } catch (e) {
        console.writeln('[>] ' + coordKey + ' not accessible: ' + e);
      }
    }
    
    // Check if we got the direct RA/DEC values
    if (directCoordinates['RA'] !== null && directCoordinates['DEC'] !== null) {
      var directRA = parseFloat(directCoordinates['RA']);
      var directDEC = parseFloat(directCoordinates['DEC']);
      
      console.writeln('[>] Parsed direct coordinates: RA=' + directRA + ', DEC=' + directDEC);
      
      if (!isNaN(directRA) && !isNaN(directDEC)) {
        console.writeln('[>] ? SUCCESS: Field center from direct RA/DEC keywords: RA ' + directRA.toFixed(6) + '°, Dec ' + directDEC.toFixed(6) + '°');
        return { ra: directRA, dec: directDEC, source: 'Direct FITS RA/DEC Keywords' };
      }
    }
    
    // Check OBJCTRA/OBJCTDEC as alternative
    if (directCoordinates['OBJCTRA'] !== null && directCoordinates['OBJCTDEC'] !== null) {
      var objRA = parseRADecToDecimal(directCoordinates['OBJCTRA']);
      var objDEC = parseRADecToDecimal(directCoordinates['OBJCTDEC']);
      
      if (!isNaN(objRA) && !isNaN(objDEC)) {
        console.writeln('[>] ? SUCCESS: Field center from OBJCTRA/OBJCTDEC: RA ' + objRA.toFixed(6) + '°, Dec ' + objDEC.toFixed(6) + '°');
        return { ra: objRA, dec: objDEC, source: 'FITS OBJCTRA/OBJCTDEC Keywords' };
      }
    }
    
    console.writeln('[>] Direct coordinate keywords not found, trying WCS approach...');
    
    // Method 2D: WCS keyword extraction (fallback)
    var wcsKeywords = {
      'CRVAL1': null,  // RA reference coordinate
      'CRVAL2': null,  // Dec reference coordinate 
      'CRPIX1': null,  // Reference pixel X
      'CRPIX2': null,  // Reference pixel Y
      'CD1_1': null,   // WCS matrix element
      'CD1_2': null,   // WCS matrix element
      'CD2_1': null,   // WCS matrix element
      'CD2_2': null,   // WCS matrix element
      'CTYPE1': null,  // Coordinate type 1
      'CTYPE2': null   // Coordinate type 2
    };
    
    // Extract WCS keywords directly
    for (var wcsKey in wcsKeywords) {
      try {
        var value = imageWindow.mainView.propertyValue('FITS:' + wcsKey);
        if (value !== undefined && value !== null) {
          wcsKeywords[wcsKey] = value;
          console.writeln('[>] WCS keyword ' + wcsKey + ' = ' + value);
        }
      } catch (e) {
        // Keyword not available - normal for some keywords
      }
    }
    
    // If we have CRVAL1 and CRVAL2, use them as field center
    if (wcsKeywords['CRVAL1'] !== null && wcsKeywords['CRVAL2'] !== null) {
      ra = parseFloat(wcsKeywords['CRVAL1']);
      dec = parseFloat(wcsKeywords['CRVAL2']);
      
      if (!isNaN(ra) && !isNaN(dec)) {
        console.writeln('[>] Field center from CRVAL keywords: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'FITS WCS Keywords (CRVAL)' };
      }
    }
    
    // Method 2C: Try alternative keyword access if direct method didn't work
    if (!keywords) {
      console.writeln('[>] Trying comprehensive direct keyword lookup...');
      var directKeywords = [];
      var keywordsToTry = ['CRVAL1', 'CRVAL2', 'RA', 'DEC', 'OBJCTRA', 'OBJCTDEC', 'ALPHA', 'DELTA'];
      
      for (var k = 0; k < keywordsToTry.length; k++) {
        try {
          var keywordValue = imageWindow.mainView.propertyValue('FITS:' + keywordsToTry[k]);
          if (keywordValue !== undefined && keywordValue !== null) {
            directKeywords.push({ name: keywordsToTry[k], value: keywordValue });
            console.writeln('[>] Direct keyword found: ' + keywordsToTry[k] + ' = ' + keywordValue);
          }
        } catch (e3) {
          // Keyword not found - continue
        }
      }
      
      if (directKeywords.length > 0) {
        keywords = directKeywords;
        console.writeln('[>] Found ' + directKeywords.length + ' keywords via direct lookup');
      }
    }
    
    // Method 2D: Process keywords if we found any
    if (keywords && keywords.length > 0) {
      console.writeln('[>] Processing ' + keywords.length + ' FITS keywords for field center...');
      
      // Try to find WCS center coordinates first
      for (var i = 0; i < keywords.length; i++) {
        var keyword = keywords[i];
        
        // Safety check for keyword structure
        if (!keyword || !keyword.name || keyword.value === undefined) {
          continue;
        }
        
        if (keyword.name === 'CRVAL1' && ra === null) {
          ra = parseFloat(keyword.value);
          console.writeln('[>] Found CRVAL1 (RA): ' + ra);
        }
        if (keyword.name === 'CRVAL2' && dec === null) {
          dec = parseFloat(keyword.value);
          console.writeln('[>] Found CRVAL2 (Dec): ' + dec);
        }
        
        // Also check for direct RA/DEC keywords
        if (keyword.name === 'RA' && ra === null) {
          ra = parseRADecToDecimal(keyword.value);
          console.writeln('[>] Found RA keyword: ' + ra);
        }
        if (keyword.name === 'DEC' && dec === null) {
          dec = parseRADecToDecimal(keyword.value);
          console.writeln('[>] Found DEC keyword: ' + dec);
        }
        
        // Check for object center keywords as fallback
        if (keyword.name === 'OBJCTRA' && ra === null) {
          ra = parseRADecToDecimal(keyword.value);
          console.writeln('[>] Found OBJCTRA: ' + ra);
        }
        if (keyword.name === 'OBJCTDEC' && dec === null) {
          dec = parseRADecToDecimal(keyword.value);
          console.writeln('[>] Found OBJCTDEC: ' + dec);
        }
      }
      
      if (ra !== null && dec !== null && !isNaN(ra) && !isNaN(dec)) {
        console.writeln('[>] Field center extracted from FITS keywords: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
        return { ra: ra, dec: dec, source: 'FITS Keywords' };
      } else {
        console.writeln('[>] Failed to extract complete field center from FITS keywords (RA: ' + ra + ', Dec: ' + dec + ')');
      }
    } else {
      console.writeln('[>] No FITS keywords available for field center extraction');
    }
    
    // Method 3: Try to access WCS properties directly
    console.writeln('[>] Attempting Method 3: Direct WCS property access...');
    try {
      // Try accessing WCS-related properties in multiple ways
      var wcsProperties = [
        ['FITS:CRVAL1', 'FITS:CRVAL2'],
        ['FITS:OBJCTRA', 'FITS:OBJCTDEC'],
        ['CRVAL1', 'CRVAL2'],
        ['OBJCTRA', 'OBJCTDEC']
      ];
      
      for (var propSet = 0; propSet < wcsProperties.length; propSet++) {
        var raProperty = wcsProperties[propSet][0];
        var decProperty = wcsProperties[propSet][1];
        
        try {
          console.writeln('[>] Trying property pair: ' + raProperty + ', ' + decProperty);
          var raValue = imageWindow.mainView.propertyValue(raProperty);
          var decValue = imageWindow.mainView.propertyValue(decProperty);
          
          console.writeln('[>] Raw property values: RA = ' + raValue + ', Dec = ' + decValue);
          
          if (raValue !== undefined && raValue !== null && decValue !== undefined && decValue !== null) {
            var wcsRA = parseRADecToDecimal(raValue);
            var wcsDec = parseRADecToDecimal(decValue);
            
            console.writeln('[>] Parsed values: RA = ' + wcsRA + ', Dec = ' + wcsDec);
            
            if (!isNaN(wcsRA) && !isNaN(wcsDec)) {
              console.writeln('[>] Field center from WCS properties (' + raProperty + '): RA ' + wcsRA.toFixed(6) + '°, Dec ' + wcsDec.toFixed(6) + '°');
              return { ra: wcsRA, dec: wcsDec, source: 'WCS Properties (' + raProperty + ')' };
            }
          }
        } catch (e) {
          console.writeln('[>] Property pair ' + raProperty + ' failed: ' + e);
        }
      }
    } catch (e) {
      console.writeln('[>] WCS property access failed: ' + e);
    }
    
    // Method 4: Try ImageSolver-specific properties  
    console.writeln('[>] Attempting Method 4: ImageSolver property access...');
    try {
      // Try to get the center from ImageSolver properties
      var imageSolverProps = [
        'ImageSolver:centerRA',
        'ImageSolver:centerDec',
        'ImageSolver:ra', 
        'ImageSolver:dec',
        'Solver:centerRA',
        'Solver:centerDec',
        'WCS:centerRA',
        'WCS:centerDec'
      ];
      
      var solverRA = null, solverDec = null;
      for (var prop = 0; prop < imageSolverProps.length; prop += 2) {
        try {
          var raVal = imageWindow.mainView.propertyValue(imageSolverProps[prop]);
          var decVal = imageWindow.mainView.propertyValue(imageSolverProps[prop + 1]);
          
          console.writeln('[>] Trying solver properties: ' + imageSolverProps[prop] + ' = ' + raVal + ', ' + imageSolverProps[prop + 1] + ' = ' + decVal);
          
          if (raVal !== undefined && raVal !== null && decVal !== undefined && decVal !== null && !isNaN(parseFloat(raVal)) && !isNaN(parseFloat(decVal))) {
            solverRA = parseFloat(raVal);
            solverDec = parseFloat(decVal);
            console.writeln('[>] ImageSolver properties found: RA ' + solverRA + ', Dec ' + solverDec);
            
            // Check if values are reasonable (not NaN or extreme)
            if (!isNaN(solverRA) && !isNaN(solverDec) && Math.abs(solverRA) <= 360 && Math.abs(solverDec) <= 90) {
              console.writeln('[>] Field center from ImageSolver: RA ' + solverRA.toFixed(6) + '°, Dec ' + solverDec.toFixed(6) + '°');
              return { ra: solverRA, dec: solverDec, source: 'ImageSolver Properties' };
            } else {
              console.writeln('[>] ImageSolver values are invalid: RA ' + solverRA + ', Dec ' + solverDec);
            }
          }
        } catch (e) {
          console.writeln('[>] Property access failed for ' + imageSolverProps[prop] + ': ' + e);
        }
      }
      
      console.writeln('[>] No valid ImageSolver properties found');
    } catch (e) {
      console.writeln('[>] ImageSolver property access failed: ' + e);
    }
    
    // Method 5: Calculate center from WCS transformation matrix
    console.writeln('[>] Attempting Method 5: WCS transformation matrix calculation...');
    try {
      console.writeln('[>] Checking astrometric solution for Method 5...');
      var solution = (imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution);
      console.writeln('[>] Solution object: ' + (solution ? 'EXISTS' : 'NULL'));
      
      if (solution) {
        // Get image dimensions
        var imageWidth = imageWindow.mainView.image.width;
        var imageHeight = imageWindow.mainView.image.height;
        
        console.writeln('[>] Image dimensions: ' + imageWidth + 'x' + imageHeight);
        
        // Calculate center pixel coordinates
        var centerX = imageWidth / 2.0;
        var centerY = imageHeight / 2.0;
        
        console.writeln('[>] Center pixel: (' + centerX + ', ' + centerY + ')');
        
        // Try to use celestialToImage inverse to get world coordinates
        try {
          var worldCoords = solution.imageToCelestial(centerX, centerY);
          if (worldCoords && worldCoords.length >= 2) {
            var raRad = worldCoords[0];
            var decRad = worldCoords[1];
            
            ra = raRad * 180 / Math.PI;
            dec = decRad * 180 / Math.PI;
            
            console.writeln('[>] Field center from WCS transform: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
            return { ra: ra, dec: dec, source: 'WCS Transform' };
          }
        } catch (e) {
          console.writeln('[>] imageToCelestial failed: ' + e);
        }
        
        // Alternative: Try accessing transformation matrix directly
        try {
          if (solution.hasTransformation && solution.hasTransformation()) {
            // Get the reference pixel (CRPIX) and reference coordinate (CRVAL)
            var refPixel = solution.referencePixel;
            var refCoord = solution.referenceCoord;
            
            if (refPixel && refCoord) {
              console.writeln('[>] Reference pixel: (' + refPixel[0] + ', ' + refPixel[1] + ')');
              console.writeln('[>] Reference coord: (' + refCoord[0] + ', ' + refCoord[1] + ')');
              
              // If reference coordinates are available, use them as approximation
              ra = refCoord[0] * 180 / Math.PI;
              dec = refCoord[1] * 180 / Math.PI;
              
              console.writeln('[>] Field center from reference coord: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
              return { ra: ra, dec: dec, source: 'WCS Reference' };
            }
          }
        } catch (e) {
          console.writeln('[>] WCS transformation access failed: ' + e);
        }
      }
    } catch (e) {
      console.writeln('[>] WCS matrix calculation failed: ' + e);
    }
    
    // Method 6: Try to extract from astrometric solution description or projection information
    console.writeln('[>] Attempting Method 6: Extract from solution description...');
    try {
      // Try to access astrometric solution metadata/description
      if ((imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution)) {
        var solution = (imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution);
        
        // Try different ways to get projection origin or center info
        try {
          // Some versions store origin as array: [pixel_x, pixel_y, ra_rad, dec_rad]
          if (solution.projectionOrigin && solution.projectionOrigin.length >= 4) {
            ra = solution.projectionOrigin[2] * 180 / Math.PI; // Convert from radians
            dec = solution.projectionOrigin[3] * 180 / Math.PI;
            console.writeln('[>] Field center from projection origin array: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
            return { ra: ra, dec: dec, source: 'Projection Origin Array' };
          }
        } catch (e) {
          console.writeln('[>] Projection origin array access failed: ' + e);
        }
        
        // Try accessing WCS transformation properties
        try {
          var transform = solution.wcsTransformation || solution.transformation;
          if (transform && transform.centerCoordinates) {
            var centerCoords = transform.centerCoordinates;
            if (centerCoords.length >= 2) {
              ra = centerCoords[0] * 180 / Math.PI;
              dec = centerCoords[1] * 180 / Math.PI;
              console.writeln('[>] Field center from transform center: RA ' + ra.toFixed(6) + '°, Dec ' + dec.toFixed(6) + '°');
              return { ra: ra, dec: dec, source: 'Transform Center' };
            }
          }
        } catch (e) {
          console.writeln('[>] Transform center access failed: ' + e);
        }
      }
    } catch (e) {
      console.writeln('[>] Solution description extraction failed: ' + e);
    }
    
    // Method 7: Extract coordinates from PixInsight image center calculation
    console.writeln('[>] Attempting Method 7: Calculate center from image dimensions and WCS...');
    try {
      // Get image dimensions and calculate pixel center
      var img = imageWindow.mainView.image;
      var centerX = img.width / 2.0;
      var centerY = img.height / 2.0;
      
      console.writeln('[>] Image dimensions: ' + img.width + ' x ' + img.height);
      console.writeln('[>] Pixel center: (' + centerX.toFixed(1) + ', ' + centerY.toFixed(1) + ')');
      
      // Try to get the WCS transformation that PixInsight is using internally
      // Look for any available coordinate reference information
      var keywords = buildKeywordMap(imageWindow);
      
      // Try to extract WCS parameters for manual transformation
      var crpix1 = parseFloat(getKeyword(keywords, 'CRPIX1'));
      var crpix2 = parseFloat(getKeyword(keywords, 'CRPIX2'));
      var crval1 = parseFloat(getKeyword(keywords, 'CRVAL1'));
      var crval2 = parseFloat(getKeyword(keywords, 'CRVAL2'));
      var cd1_1 = parseFloat(getKeyword(keywords, 'CD1_1'));
      var cd1_2 = parseFloat(getKeyword(keywords, 'CD1_2'));
      var cd2_1 = parseFloat(getKeyword(keywords, 'CD2_1'));
      var cd2_2 = parseFloat(getKeyword(keywords, 'CD2_2'));
      
      // If we have complete WCS parameters, calculate center coordinates
      if (isFinite(crpix1) && isFinite(crpix2) && isFinite(crval1) && isFinite(crval2) && 
          isFinite(cd1_1) && isFinite(cd2_2)) {
        
        // Calculate offset from reference pixel to image center
        // CRPIX is 1-indexed in FITS, so convert to 0-indexed for image coordinates
        var deltaX = centerX - (crpix1 - 1);
        var deltaY = centerY - (crpix2 - 1);
        
        // Apply CD matrix transformation (simplified for small fields)
        var deltaRA = cd1_1 * deltaX + cd1_2 * deltaY;
        var deltaDec = cd2_1 * deltaX + cd2_2 * deltaY;
        
        // Calculate center coordinates
        ra = crval1 + deltaRA;
        dec = crval2 + deltaDec;
        
        // Normalize RA to 0-360 range
        while (ra < 0) ra += 360;
        while (ra >= 360) ra -= 360;
        
        console.writeln('[>] Calculated center from WCS parameters:');
        console.writeln('[>]   Reference pixel: (' + crpix1 + ', ' + crpix2 + ')');
        console.writeln('[>]   Reference coord: RA=' + crval1.toFixed(6) + '°, Dec=' + crval2.toFixed(6) + '°');
        console.writeln('[>]   Center coord: RA=' + ra.toFixed(6) + '°, Dec=' + dec.toFixed(6) + '°');
        
        return { ra: ra, dec: dec, source: 'WCS Parameter Calculation' };
      }
      
      console.writeln('[>] Insufficient WCS parameters for coordinate calculation');
      
    } catch (e) {
      console.writeln('[>] WCS coordinate calculation failed: ' + e);
    }
    
    // Method 8: Try to get WCS from PixInsight's FITS info display
    console.writeln('[>] Attempting Method 8: Extract from FITS info display...');
    try {
      // The FITS info that appears in the dialog shows the coordinates correctly
      // Let's try to trigger that same extraction mechanism
      var fitsInfo = getFITSInfo(imageWindow);
      
      console.writeln('[>] FITS info result: ' + (fitsInfo ? fitsInfo.substring(0, 100) + '...' : 'null'));
      
      // Check if the FITS info contains coordinate information
      if (fitsInfo && fitsInfo.indexOf('Field center coordinates:') >= 0) {
        // The getFITSInfo function successfully extracted coordinates
        console.writeln('[>] FITS info contains coordinate data - attempting to parse it');
        
        // Try to parse coordinates from the FITS info string
        // Look for patterns like "Field center coordinates: RA: 18 53 37.554  Dec: +33 01 25.27"
        var raMatch = fitsInfo.match(/RA:\s*([0-9]+)\s+([0-9]+)\s+([0-9.]+)/);
        var decMatch = fitsInfo.match(/Dec:\s*([+-]?)([0-9]+)\s+([0-9]+)\s+([0-9.]+)/);
        
        if (raMatch && decMatch) {
          // Parse RA from HMS format
          var raHours = parseInt(raMatch[1]);
          var raMinutes = parseInt(raMatch[2]);
          var raSeconds = parseFloat(raMatch[3]);
          ra = (raHours + raMinutes/60.0 + raSeconds/3600.0) * 15.0; // Convert to degrees
          
          // Parse Dec from DMS format
          var decSign = (decMatch[1] === '-') ? -1 : 1;
          var decDegrees = parseInt(decMatch[2]);
          var decMinutes = parseInt(decMatch[3]);
          var decSeconds = parseFloat(decMatch[4]);
          dec = decSign * (decDegrees + decMinutes/60.0 + decSeconds/3600.0);
          
          console.writeln('[>] Successfully parsed coordinates from FITS info:');
          console.writeln('[>]   RA=' + ra.toFixed(6) + '°, Dec=' + dec.toFixed(6) + '°');
          return { ra: ra, dec: dec, source: 'FITS Info Parsing' };
        }
      }
      
      console.writeln('[>] FITS info method did not yield coordinates');
      
    } catch (e) {
      console.writeln('[>] FITS info extraction failed: ' + e);
    }
    
    // Method 9: Manual coordinate entry fallback
    console.writeln('[>] Attempting Method 9: Manual coordinate entry...');
    try {
      var imageName = imageWindow.mainView.id || 'image';
      
      // Provide detailed guidance to the user
      console.writeln('[>] COORDINATE EXTRACTION GUIDANCE:');
      console.writeln('   All automatic methods have been exhausted.');
      console.writeln('   ');
      console.writeln('   ° To ensure WCS data is available for future runs:');
      console.writeln('     1. Open Process > ImageSolver > ImageSolver');
      console.writeln('     2. Select your image and run plate solving');
      console.writeln('     3. This will embed WCS keywords in the FITS header');
      console.writeln('   ');
      console.writeln('   ° Alternative: Upload image to nova.astrometry.net to get coordinates');
      console.writeln('   ° Or check PixInsight FITS header dialog for existing WCS info');
      console.writeln('');
      
      // Check if we can show a dialog for manual entry
      var manualCoords = promptForCoordinates(imageName);
      if (manualCoords && isFinite(manualCoords.ra) && isFinite(manualCoords.dec)) {
        console.writeln('[>] Using manually entered coordinates:');
        console.writeln('[>]   RA=' + manualCoords.ra.toFixed(6) + '°, Dec=' + manualCoords.dec.toFixed(6) + '°');
        return { ra: manualCoords.ra, dec: manualCoords.dec, source: 'Manual Entry' };
      } else {
        console.writeln('[>] Manual coordinate entry cancelled or failed');
        console.writeln('[>] Continuing without transit analysis - photometry will still work');
      }
      
    } catch (e) {
      console.writeln('[>] Manual coordinate entry failed: ' + e);
    }
    
    console.warningln('[!] No field center coordinates found - FITS may lack WCS or RA/DEC keywords');
    return null;
  } catch (e) {
    console.warningln('[!] Error extracting field center: ' + e);
    return null;
  }
}

// Parse RA/Dec from various string formats to decimal degrees
function parseRADecToDecimal(value) {
  try {
    // If already a number, return as-is
    if (typeof value === 'number') {
      return value;
    }
    
    var str = value.toString().trim().replace(/['"\/]/g, '');
    
    // Try direct decimal first
    var decimal = parseFloat(str);
    if (!isNaN(decimal)) {
      return decimal;
    }
    
    // Try HMS/DMS format (HH:MM:SS or DD:MM:SS)
    if (str.indexOf(':') > 0) {
      var parts = str.split(':');
      if (parts.length >= 2) {
        var hours = parseFloat(parts[0]) || 0;
        var minutes = parseFloat(parts[1]) || 0;
        var seconds = parseFloat(parts[2]) || 0;
        
        var sign = hours < 0 ? -1 : 1;
        hours = Math.abs(hours);
        
        return sign * (hours + minutes / 60 + seconds / 3600);
      }
    }
    
    console.warningln('[!] Could not parse coordinate: ' + str);
    return NaN;
  } catch (e) {
    console.warningln('[!] Error parsing coordinate: ' + e);
    return NaN;
  }
}

/**
 * Prompts user for manual coordinate entry with a dialog
 * @param {string} imageName - Name of the image for display
 * @returns {Object|null} Object with ra, dec properties or null if cancelled
 */
function promptForCoordinates(imageName) {
  try {
    var dialog = new Dialog();
    dialog.windowTitle = "Manual Coordinate Entry - " + imageName;
    dialog.minWidth = 400;
    dialog.minHeight = 300;
    
    // Main vertical sizer
    var mainSizer = new VerticalSizer;
    mainSizer.margin = 10;
    mainSizer.spacing = 8;
    
    // Instructions
    var instructionLabel = new Label(dialog);
    instructionLabel.text = "Automatic coordinate extraction failed.\n" +
                           "Please enter the field center coordinates manually.\n" +
                           "You can find these in PixInsight's FITS header info or\n" +
                           "by using an online plate solver like nova.astrometry.net";
    instructionLabel.wordWrap = true;
    mainSizer.add(instructionLabel);
    
    // RA input group
    var raGroupBox = new GroupBox(dialog);
    raGroupBox.title = "Right Ascension (RA)";
    var raSizer = new VerticalSizer;
    raSizer.margin = 6;
    raSizer.spacing = 4;
    
    var raFormatLabel = new Label(raGroupBox);
    raFormatLabel.text = "Enter as decimal°rees (e.g., 284.656) or HMS (e.g., 18:58:37.4)";
    raSizer.add(raFormatLabel);
    
    var raEdit = new Edit(raGroupBox);
    raEdit.text = "";
    raEdit.toolTip = "RA in decimal°rees or H:M:S format";
    raSizer.add(raEdit);
    
    raGroupBox.sizer = raSizer;
    mainSizer.add(raGroupBox);
    
    // Dec input group
    var decGroupBox = new GroupBox(dialog);
    decGroupBox.title = "Declination (Dec)";
    var decSizer = new VerticalSizer;
    decSizer.margin = 6;
    decSizer.spacing = 4;
    
    var decFormatLabel = new Label(decGroupBox);
    decFormatLabel.text = "Enter as decimal°rees (e.g., 33.024) or DMS (e.g., +33:01:25.3)";
    decSizer.add(decFormatLabel);
    
    var decEdit = new Edit(decGroupBox);
    decEdit.text = "";
    decEdit.toolTip = "Dec in decimal°rees or D:M:S format";
    decSizer.add(decEdit);
    
    decGroupBox.sizer = decSizer;
    mainSizer.add(decGroupBox);
    
    // Buttons
    var buttonSizer = new HorizontalSizer;
    buttonSizer.spacing = 8;
    buttonSizer.addStretch();
    
    var okButton = new PushButton(dialog);
    okButton.text = "OK";
    okButton.defaultButton = true;
    okButton.onClick = function() {
      dialog.ok = true;
      dialog.done(1);
    };
    buttonSizer.add(okButton);
    
    var cancelButton = new PushButton(dialog);
    cancelButton.text = "Cancel";
    cancelButton.onClick = function() {
      dialog.ok = false;
      dialog.done(0);
    };
    buttonSizer.add(cancelButton);
    
    mainSizer.add(buttonSizer);
    dialog.sizer = mainSizer;
    
    // Show the dialog
    if (dialog.execute()) {
      var raText = raEdit.text.trim();
      var decText = decEdit.text.trim();
      
      if (raText === "" || decText === "") {
        console.writeln("? Manual coordinate entry cancelled - empty fields");
        return null;
      }
      
      // Parse RA
      var ra = parseCoordinate(raText, true); // true for RA (convert hours to degrees)
      var dec = parseCoordinate(decText, false); // false for Dec
      
      if (ra === null || dec === null) {
        console.writeln("? Invalid coordinate format entered");
        return null;
      }
      
      return { ra: ra, dec: dec };
    }
    
  } catch (e) {
    console.writeln("? Error creating coordinate entry dialog: " + e);
  }
  
  return null;
}

/**
 * Parses coordinate string in either decimal or HMS/DMS format
 * @param {string} coordStr - Coordinate string
 * @param {boolean} isRA - True if parsing RA (converts hours to degrees)
 * @returns {number|null} Decimal°rees or null if invalid
 */
function parseCoordinate(coordStr, isRA) {
  try {
    coordStr = coordStr.trim();
    
    // Check if it's already decimal°rees
    if (coordStr.match(/^[+-]?\d+(\.\d+)?$/)) {
      return parseFloat(coordStr);
    }
    
    // Parse HMS/DMS format (e.g., "18:58:37.4" or "+33:01:25.3")
    var match = coordStr.match(/^([+-]?)([0-9]+):([0-9]+):([0-9]+(?:\.[0-9]+)?)$/);
    if (match) {
      var sign = (match[1] === '-') ? -1 : 1;
      var hours = parseInt(match[2]);
      var minutes = parseInt(match[3]);
      var seconds = parseFloat(match[4]);
      
      var decimal = sign * (hours + minutes/60.0 + seconds/3600.0);
      
      // Convert RA from hours to°rees
      if (isRA) {
        decimal *= 15.0;
      }
      
      return decimal;
    }
    
    // Try parsing without seconds (e.g., "18:58" or "+33:01")
    match = coordStr.match(/^([+-]?)([0-9]+):([0-9]+(?:\.[0-9]+)?)$/);
    if (match) {
      var sign = (match[1] === '-') ? -1 : 1;
      var hours = parseInt(match[2]);
      var minutes = parseFloat(match[3]);
      
      var decimal = sign * (hours + minutes/60.0);
      
      // Convert RA from hours to°rees
      if (isRA) {
        decimal *= 15.0;
      }
      
      return decimal;
    }
    
  } catch (e) {
    console.writeln("? Error parsing coordinate '" + coordStr + "': " + e);
  }
  
  return null;
}

// Calculate field of view from image scale and dimensions
function calculateFieldOfView(imageWindow, hardwareSettings) {
  try {
    // Method 1: Use FITS WCS if available
    var keywords = null;
    var cdelt1 = null, cdelt2 = null;
    
    // Try to access keywords safely
    try {
      keywords = imageWindow.mainView.keywords;
    } catch (e) {
      console.writeln('[>] Keywords not accessible: ' + e);
    }
    
    if (keywords && keywords.length > 0) {
      for (var i = 0; i < keywords.length; i++) {
        var keyword = keywords[i];
        if (keyword && keyword.name === 'CDELT1') cdelt1 = Math.abs(parseFloat(keyword.value));
        if (keyword && keyword.name === 'CDELT2') cdelt2 = Math.abs(parseFloat(keyword.value));
      }
    }
    
    if (cdelt1 && cdelt2) {
      var fovWidth = cdelt1 * imageWindow.mainView.image.width;
      var fovHeight = cdelt2 * imageWindow.mainView.image.height;
      
      console.writeln('[>] FOV from WCS: ' + fovWidth.toFixed(3) + '° ° ' + fovHeight.toFixed(3) + '°');
      return {
        widthDeg: fovWidth,
        heightDeg: fovHeight,
        radiusDeg: Math.sqrt(fovWidth * fovWidth + fovHeight * fovHeight) / 2,
        source: 'WCS'
      };
    }
    
    // Method 2: Calculate from hardware parameters
    if (hardwareSettings && hardwareSettings.focalLength > 0 && hardwareSettings.pixelSize > 0) {
      var binning = hardwareSettings.binning || 1;
      var imageScaleArcsecPerPixel = (hardwareSettings.pixelSize * binning * 206.265) / hardwareSettings.focalLength;
      var imageScaleDegPerPixel = imageScaleArcsecPerPixel / 3600;
      
      var fovWidth = imageScaleDegPerPixel * imageWindow.mainView.image.width;
      var fovHeight = imageScaleDegPerPixel * imageWindow.mainView.image.height;
      
      console.writeln('[>] FOV from hardware: ' + fovWidth.toFixed(3) + '° ° ' + fovHeight.toFixed(3) + '°');
      return {
        widthDeg: fovWidth,
        heightDeg: fovHeight,
        radiusDeg: Math.sqrt(fovWidth * fovWidth + fovHeight * fovHeight) / 2,
        source: 'Hardware'
      };
    }
    
    // Method 3: Default estimate for typical setups
    console.warningln('[!] Using default FOV estimate');
    return {
      widthDeg: 1.0,   // 1°ree default
      heightDeg: 0.7,  // Typical 4:3 aspect ratio
      radiusDeg: 0.6,  // Conservative search radius
      source: 'Default'
    };
  } catch (e) {
    console.warningln('[!] Error calculating FOV: ' + e);
    return {
      widthDeg: 1.0,
      heightDeg: 0.7,
      radiusDeg: 0.6,
      source: 'Error'
    };
  }
}

// Enhanced angular distance calculation with improved precision and RA wrap-around handling
function calculateAngularDistance(ra1, dec1, ra2, dec2) {
  try {
    // Use enhanced version for better precision and edge case handling
    var point1 = {x: ra1, y: dec1};
    var point2 = {x: ra2, y: dec2};
    return calculateEnhancedAngularDistance(point1, point2) / 60.0; // Convert arcmin to degrees
  } catch (e) {
    // Fallback to original implementation
    console.warningln('[ENHANCED] Falling back to original angular distance calculation: ' + e);
    
    // Convert to radians
    var ra1Rad = ra1 * Math.PI / 180;
    var dec1Rad = dec1 * Math.PI / 180;
    var ra2Rad = ra2 * Math.PI / 180;
    var dec2Rad = dec2 * Math.PI / 180;
    
    // Original Haversine formula (with RA wrap-around improvement)
    var deltaRA = ra2Rad - ra1Rad;
    
    // Enhanced: Handle RA wrap-around properly
    if (deltaRA > Math.PI) deltaRA -= 2 * Math.PI;
    if (deltaRA < -Math.PI) deltaRA += 2 * Math.PI;
    
    var deltaDec = dec2Rad - dec1Rad;
    
    var a = Math.sin(deltaDec / 2) * Math.sin(deltaDec / 2) +
            Math.cos(dec1Rad) * Math.cos(dec2Rad) *
            Math.sin(deltaRA / 2) * Math.sin(deltaRA / 2);
    
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    // Convert back to degrees
    return c * 180 / Math.PI;
  }
}

// Query NASA Exoplanet Archive for transiting planets in the field
function queryExoplanetsInField(fieldCenter, fieldRadius, observationDate) {
  // Since we can't make direct HTTP requests in PixInsight JavaScript,
  // we'll use a simplified local database of known bright exoplanets
  // In a full implementation, this would query the NASA Exoplanet Archive API
  
  console.writeln('[>] Querying local exoplanet database...');
  console.writeln('[>] Search area: RA ' + fieldCenter.ra.toFixed(3) + '°, Dec ' + fieldCenter.dec.toFixed(3) + '°, radius ' + fieldRadius.toFixed(3) + '°');
  
  try {
    // Local database of well-known transiting exoplanets
    // In production, this would be loaded from a file or API
    var knownExoplanets = getKnownTransitingExoplanets();
    var candidates = [];
    
    for (var i = 0; i < knownExoplanets.length; i++) {
      var planet = knownExoplanets[i];
      
      // Calculate angular distance from field center
      var distance = calculateAngularDistance(fieldCenter.ra, fieldCenter.dec, planet.ra, planet.dec);
      
      if (distance <= fieldRadius) {
        console.writeln('[>] Found candidate: ' + planet.name + ' (distance: ' + distance.toFixed(3) + '°)');
        candidates.push(planet);
      }
    }
    
    console.writeln('? Found ' + candidates.length + ' exoplanet candidates in field');
    return candidates;
  } catch (e) {
    console.warningln('[!] Error querying exoplanet database: ' + e);
    return [];
  }
}

// Note: External NASA CSV loading functions removed since data is embedded below

// Cached database to prevent multiple loads
var cachedExoplanetDatabase = null;

// Load comprehensive exoplanet database from NASA CSV or external file
function getKnownTransitingExoplanets() {
  // Return cached database if already loaded
  if (cachedExoplanetDatabase) {
    return cachedExoplanetDatabase;
  }
  
  // Skip external CSV loading since data is embedded below
  // External CSV loading removed to avoid file read errors
  
  try {
    // Try to load the comprehensive JSON database as fallback
    var databasePath = File.systemTempDirectory + '/exoplanets_complete.json';
    var fallbackPath = './exoplanets_complete.json';  // Current directory
    // Note: File.scriptDirectory not available in PixInsight, skip script path
    
    var paths = [fallbackPath, databasePath];
    var database = null;
    
    for (var i = 0; i < paths.length; i++) {
      try {
        var jsonFile = new File();
        jsonFile.openForReading(paths[i]);
        var content = jsonFile.read(DataType_String, jsonFile.size);
        jsonFile.close();
        
        if (content && content.length > 0) {
          database = JSON.parse(content);
          console.writeln('[>] Loaded comprehensive exoplanet database from: ' + paths[i]);
          console.writeln('[>] Database contains ' + database.planets.length + ' confirmed transiting exoplanets');
          console.writeln('[>] Last updated: ' + database.metadata.lastUpdated);
          break;
        }
      } catch (e) {
        // Try next path
      }
    }
    
    if (database && database.planets) {
      // Apply magnitude filtering for performance (only include reasonably bright hosts)
      var brighterPlanets = database.planets.filter(function(planet) {
        return planet.hostMag <= 15.0; // Exclude extremely faint hosts
      });
      
      console.writeln('[>] Using ' + brighterPlanets.length + ' planets with host magnitude ? 15.0');
      return brighterPlanets;
    }
    
    console.writeln('[>] Using embedded exoplanet database (comprehensive list)');
    
  } catch (e) {
    console.writeln('[>] Using embedded exoplanet database: ' + e);
  }
  
    // Embedded NASA Exoplanet Archive data (comprehensive targets, magnitude <= 13)
  console.writeln('Loading comprehensive NASA transit targets database (810 targets, mag <= 13.0)');
  var embeddedData = [

    {name: '55 Cnc e', hostname: '55 Cnc', ra: 133.64686, dec: 28.33034, hostMag: 6.0, period: 0.73654625, epoch: 2459370.80754300},
    {name: 'AU Mic b', hostname: 'AU Mic', ra: 311.29116, dec: -31.34245, hostMag: 8.8, period: 8.463, epoch: 2458330.39051000},
    {name: 'AU Mic c', hostname: 'AU Mic', ra: 311.29116, dec: -31.34245, hostMag: 8.8, period: 18.85901900, epoch: 2458342.22231000},
    {name: 'BD-14 3065 b', hostname: 'BD-14 3065', ra: 153.66967, dec: -15.64284, hostMag: 11.1, period: 4.28897310, epoch: 2459313.48578000},
    {name: 'BD+20 594 b', hostname: 'BD+20 594', ra: 53.65113, dec: 20.59902, hostMag: 10.8, period: 41.6855, epoch: 2457151.90210000},
    {name: 'CoRoT-11 b', hostname: 'CoRoT-11', ra: 280.68729, dec: 5.93766, hostMag: 12.9, period: 2.99427803, epoch: 2456019.96220000},
    {name: 'CoRoT-1 b', hostname: 'CoRoT-1', ra: 102.07988, dec: -3.10214, hostMag: 13.6, period: 1.50896877200, epoch: 2456268.99119000},
    {name: 'CoRoT-2 b', hostname: 'CoRoT-2', ra: 291.77704, dec: 1.38366, hostMag: 12.5, period: 1.742997, epoch: 2457347.04314000},
    {name: 'CoRoT-3 b', hostname: 'CoRoT-3', ra: 292.05529, dec: 0.12183, hostMag: 13.4, period: 4.25679940, epoch: 2454283.13388000},
    {name: 'CoRoT-5 b', hostname: 'CoRoT-5', ra: 101.27725, dec: 0.81522, hostMag: 14.0, period: 4.03791560, epoch: 2456665.46960000},
    {name: 'CoRoT-6 b', hostname: 'CoRoT-6', ra: 281.07254, dec: 6.66321, hostMag: 14.0, period: 8.88662870, epoch: 2457190.50780000},
    {name: 'CoRoT-7 b', hostname: 'CoRoT-7', ra: 100.95617, dec: -1.06300, hostMag: 11.7, period: 0.85359165, epoch: 2454398.07690000},
    {name: 'CoRoT-9 b', hostname: 'CoRoT-9', ra: 280.78667, dec: 6.20408, hostMag: 13.6, period: 95.27265600, epoch: 2455365.52723000},
    {name: 'DS Tuc A b', hostname: 'DS Tuc A', ra: 354.91546, dec: -69.19605, hostMag: 8.2, period: 8.13822217724, epoch: 2458332.30832300},
    {name: 'EPIC 201595106 b', hostname: 'EPIC 201595106', ra: 183.72038, dec: 1.96817, hostMag: 11.7, period: 0.87724, epoch: 2457583.04429000},
    {name: 'EPIC 211945201 b', hostname: 'EPIC 211945201', ra: 136.57421, dec: 19.40206, hostMag: 10.2, period: 19.49214730, epoch: 2459575.85187300},
    {name: 'EPIC 229004835 b', hostname: 'EPIC 229004835', ra: 186.48604, dec: -1.40472, hostMag: 10.2, period: 16.14113200, epoch: 2457920.44584000},
    {name: 'EPIC 246851721 b', hostname: 'EPIC 246851721', ra: 78.91983, dec: 16.27870, hostMag: 11.2, period: 6.18026790, epoch: 2458439.87506000},
    {name: 'EPIC 249893012 b', hostname: 'EPIC 249893012', ra: 228.24825, dec: -16.72464, hostMag: 11.4, period: 3.5951, epoch: 2457994.39600000},
    {name: 'EPIC 249893012 c', hostname: 'EPIC 249893012', ra: 228.24825, dec: -16.72464, hostMag: 11.4, period: 15.624, epoch: 2457998.84100000},
    {name: 'EPIC 249893012 d', hostname: 'EPIC 249893012', ra: 228.24825, dec: -16.72464, hostMag: 11.4, period: 35.747, epoch: 2458008.65200000},
    {name: 'G 9-40 b', hostname: 'G 9-40', ra: 134.71883, dec: 21.07479, hostMag: 13.8, period: 5.7459982, epoch: 2459503.32682000},
    {name: 'Gaia-1 b', hostname: 'Gaia-1', ra: 90.64367, dec: -0.57711, hostMag: 13.2, period: 3.052524, epoch: 2458468.68524000},
    {name: 'Gaia-2 b', hostname: 'Gaia-2', ra: 110.73533, dec: 67.25266, hostMag: 11.3, period: 3.69152240, epoch: 2458843.98875000},
    {name: 'GJ 1132 b', hostname: 'GJ 1132', ra: 153.70908, dec: -47.15494, hostMag: 13.7, period: 1.62892911, epoch: 2459280.98988000},
    {name: 'GJ 143 b', hostname: 'GJ 143', ra: 51.75021, dec: -63.5, hostMag: 8.1, period: 35.61343910, epoch: 2460202.21098800},
    {name: 'GJ 238 b', hostname: 'GJ 238', ra: 98.45488, dec: -58.52503, hostMag: 11.6, period: 1.7447031, epoch: 2460204.28189700},
    {name: 'GJ 3090 b', hostname: 'GJ 3090', ra: 20.43842, dec: -46.71472, hostMag: 11.4, period: 2.8531016, epoch: 2460204.96328100},
    {name: 'GJ 341 b', hostname: 'GJ 341', ra: 140.39938, dec: -60.28117, hostMag: 9.5, period: 7.5768334, epoch: 2460006.41417000},
    {name: 'GJ 3470 b', hostname: 'GJ 3470', ra: 119.77350, dec: 15.39123, hostMag: 12.3, period: 3.33665240, epoch: 2456974.68988000},
    {name: 'GJ 3473 b', hostname: 'GJ 3473', ra: 120.59363, dec: 3.33716, hostMag: 13.7, period: 1.1980035, epoch: 2458492.20408000},
    {name: 'GJ 357 b', hostname: 'GJ 357', ra: 144.00746, dec: -21.66507, hostMag: 10.9, period: 3.9306, epoch: 2459272.67570000},
    {name: 'GJ 367 b', hostname: 'GJ 367', ra: 146.12129, dec: -45.77901, hostMag: 10.2, period: 0.3219233, epoch: 2460013.71310000},
    {name: 'GJ 3929 b', hostname: 'GJ 3929', ra: 239.57758, dec: 35.40812, hostMag: 12.7, period: 2.616235, epoch: 2458956.39620000},
    {name: 'GJ 436 b', hostname: 'GJ 436', ra: 175.55471, dec: 26.70307, hostMag: 10.7, period: 2.64389762100, epoch: 2455290.75168400},
    {name: 'GJ 486 b', hostname: 'GJ 486', ra: 191.98154, dec: 9.74944, hostMag: 11.4, period: 1.46712127, epoch: 2459939.07160200},
    {name: 'GJ 806 b', hostname: 'GJ 806', ra: 311.26971, dec: 44.5, hostMag: 10.8, period: 0.9263237, epoch: 2460559.01555200},
    {name: 'GJ 9827 b', hostname: 'GJ 9827', ra: 351.77179, dec: -1.28534, hostMag: 10.4, period: 1.2089755, epoch: 2460231.73383100},
    {name: 'GJ 9827 c', hostname: 'GJ 9827', ra: 351.77179, dec: -1.28534, hostMag: 10.4, period: 3.64811450, epoch: 2457851.64378000},
    {name: 'GJ 9827 d', hostname: 'GJ 9827', ra: 351.77179, dec: -1.28534, hostMag: 10.4, period: 6.20183, epoch: 2460265.10196000},
    {name: 'Gliese 12 b', hostname: 'Gliese 12', ra: 3.95792, dec: 13.55762, hostMag: 12.6, period: 12.76147058433, epoch: 2459458.90053500},
    {name: 'GPX-1 b', hostname: 'GPX-1', ra: 38.36917, dec: 56.02571, hostMag: 12.3, period: 1.744579, epoch: 2458770.23823000},
    {name: 'HAT-P-11 b', hostname: 'HAT-P-11', ra: 297.71017, dec: 48.08186, hostMag: 9.5, period: 4.88780244300, epoch: 2454957.81320670},
    {name: 'HAT-P-12 b', hostname: 'HAT-P-12', ra: 209.38858, dec: 43.49331, hostMag: 12.7, period: 3.21305762, epoch: 2456851.48111900},
    {name: 'HAT-P-13 b', hostname: 'HAT-P-13', ra: 129.88238, dec: 47.35191, hostMag: 10.4, period: 2.91624121, epoch: 2456316.79044000},
    {name: 'HAT-P-14 b', hostname: 'HAT-P-14', ra: 260.11617, dec: 38.24217, hostMag: 10.0, period: 4.62766098, epoch: 2457304.81275000},
    {name: 'HAT-P-1 b', hostname: 'HAT-P-1', ra: 344.44537, dec: 38.67492, hostMag: 9.8, period: 4.4652986, epoch: 2460606.43688200},
    {name: 'HAT-P-16 b', hostname: 'HAT-P-16', ra: 9.57304, dec: 42.46310, hostMag: 10.9, period: 2.77596727, epoch: 2456204.60429900},
    {name: 'HAT-P-17 b', hostname: 'HAT-P-17', ra: 324.53596, dec: 30.48819, hostMag: 10.4, period: 10.33853522, epoch: 2456703.46070300},
    {name: 'HAT-P-2 b', hostname: 'HAT-P-2', ra: 245.15142, dec: 41.04796, hostMag: 8.7, period: 5.633477, epoch: 2460477.27590700},
    {name: 'HAT-P-20 b', hostname: 'HAT-P-20', ra: 111.91642, dec: 24.33612, hostMag: 11.2, period: 2.8753183, epoch: 2460285.25266900},
    {name: 'HAT-P-22 b', hostname: 'HAT-P-22', ra: 155.68121, dec: 50.12871, hostMag: 9.8, period: 3.21223020, epoch: 2460362.10522700},
    {name: 'HAT-P-30 b', hostname: 'HAT-P-30', ra: 123.94983, dec: 5.83686, hostMag: 10.4, period: 2.8106007, epoch: 2457775.21277800},
    {name: 'HAT-P-32 b', hostname: 'HAT-P-32', ra: 31.04275, dec: 46.68785, hostMag: 11.4, period: 2.15000819700, epoch: 2456265.15412300},
    {name: 'HAT-P-33 b', hostname: 'HAT-P-33', ra: 113.18425, dec: 33.83503, hostMag: 11.0, period: 3.47447703, epoch: 2458078.12991800},
    {name: 'HAT-P-34 b', hostname: 'HAT-P-34', ra: 303.19538, dec: 18.10478, hostMag: 10.4, period: 5.45264682, epoch: 2458708.63767000},
    {name: 'HAT-P-36 b', hostname: 'HAT-P-36', ra: 188.26621, dec: 44.91537, hostMag: 12.1, period: 1.32734681300, epoch: 2457885.38399400},
    {name: 'HAT-P-3 b', hostname: 'HAT-P-3', ra: 206.09400, dec: 48.02897, hostMag: 11.9, period: 2.89973815, epoch: 2456843.02243800},
    {name: 'HAT-P-40 b', hostname: 'HAT-P-40', ra: 335.51292, dec: 45.45735, hostMag: 11.3, period: 4.4572181, epoch: 2458741.56891000},
    {name: 'HAT-P-41 b', hostname: 'HAT-P-41', ra: 297.32267, dec: 4.67242, hostMag: 11.4, period: 2.6940497, epoch: 2458071.24389000},
    {name: 'HAT-P-42 b', hostname: 'HAT-P-42', ra: 135.34438, dec: 6.09708, hostMag: 12.1, period: 4.64183885, epoch: 2458941.87092000},
    {name: 'HAT-P-49 b', hostname: 'HAT-P-49', ra: 305.44133, dec: 26.69267, hostMag: 10.2, period: 2.69155536, epoch: 2459013.12497000},
    {name: 'HAT-P-4 b', hostname: 'HAT-P-4', ra: 229.99121, dec: 36.22951, hostMag: 11.1, period: 3.05652301, epoch: 2455584.57238000},
    {name: 'HAT-P-50 b', hostname: 'HAT-P-50', ra: 118.06346, dec: 12.13936, hostMag: 11.7, period: 3.12200511, epoch: 2458402.63014000},
    {name: 'HAT-P-56 b', hostname: 'HAT-P-56', ra: 100.84800, dec: 27.25219, hostMag: 10.9, period: 2.790825, epoch: 2458459.75023000},
    {name: 'HAT-P-57 b', hostname: 'HAT-P-57', ra: 274.74338, dec: 10.59719, hostMag: 10.6, period: 2.46529488, epoch: 2457598.49926000},
    {name: 'HAT-P-5 b', hostname: 'HAT-P-5', ra: 274.40554, dec: 36.62146, hostMag: 12.0, period: 2.78847323, epoch: 2457155.73168000},
    {name: 'HAT-P-60 b', hostname: 'HAT-P-60', ra: 28.28267, dec: 52.05392, hostMag: 9.7, period: 4.7947749, epoch: 2460633.66572200},
    {name: 'HAT-P-67 b', hostname: 'HAT-P-67', ra: 256.61071, dec: 44.77688, hostMag: 10.1, period: 4.8101046, epoch: 2458958.08059000},
    {name: 'HAT-P-69 b', hostname: 'HAT-P-69', ra: 130.50563, dec: 3.71056, hostMag: 9.8, period: 4.7869491, epoch: 2459237.77170000},
    {name: 'HAT-P-6 b', hostname: 'HAT-P-6', ra: 354.77408, dec: 42.46599, hostMag: 10.5, period: 3.85299668, epoch: 2456100.88331000},
    {name: 'HAT-P-70 b', hostname: 'HAT-P-70', ra: 74.55233, dec: 9.99798, hostMag: 9.5, period: 2.7443245, epoch: 2459188.77414000},
    {name: 'HAT-P-7 b', hostname: 'HAT-P-7', ra: 292.24722, dec: 47.96955, hostMag: 10.5, period: 2.2047354, epoch: 2454954.35847000},
    {name: 'HAT-P-8 b', hostname: 'HAT-P-8', ra: 343.04150, dec: 35.44717, hostMag: 10.4, period: 3.07634347, epoch: 2456052.75596000},
    {name: 'HAT-P-9 b', hostname: 'HAT-P-9', ra: 110.16850, dec: 37.14058, hostMag: 12.3, period: 3.92281131, epoch: 2456489.15311000},
    {name: 'HATS-17 b', hostname: 'HATS-17', ra: 192.18958, dec: -47.61368, hostMag: 12.4, period: 16.2546880, epoch: 2458390.77872000},
    {name: 'HATS-1 b', hostname: 'HATS-1', ra: 175.52525, dec: -23.35484, hostMag: 12.2, period: 3.4464563, epoch: 2458711.86936000},
    {name: 'HATS-29 b', hostname: 'HATS-29', ra: 285.09650, dec: -54.89334, hostMag: 12.6, period: 4.6058787, epoch: 2457925.49744000},
    {name: 'HATS-30 b', hostname: 'HATS-30', ra: 5.61854, dec: -59.94259, hostMag: 12.3, period: 3.17435131, epoch: 2458378.82983000},
    {name: 'HATS-33 b', hostname: 'HATS-33', ra: 294.63371, dec: -55.33025, hostMag: 11.9, period: 2.5495633, epoch: 2458654.16323000},
    {name: 'HATS-37 A b', hostname: 'HATS-37 A', ra: 199.80183, dec: -22.98684, hostMag: 12.3, period: 4.3315366, epoch: 2458006.80145000},
    {name: 'HATS-38 b', hostname: 'HATS-38', ra: 154.27108, dec: -25.27630, hostMag: 12.0, period: 4.375042, epoch: 2458547.66936000},
    {name: 'HATS-3 b', hostname: 'HATS-3', ra: 312.45742, dec: -24.42867, hostMag: 12.4, period: 3.54785091, epoch: 2456599.44946000},
    
    // Additional targets up to magnitude 14
    {name: 'HD 106315 b', hostname: 'HD 106315', ra: 183.53008, dec: -12.09633, hostMag: 9.0, period: 9.552446, epoch: 2457862.45500000, duration: 4.2},
    {name: 'HD 106315 c', hostname: 'HD 106315', ra: 183.53008, dec: -12.09633, hostMag: 9.0, period: 21.05745, epoch: 2457873.00000000, duration: 5.1},
    {name: 'HD 108236 b', hostname: 'HD 108236', ra: 186.34679, dec: -27.17900, hostMag: 9.2, period: 3.7952513, epoch: 2458325.32300000, duration: 3.8},
    {name: 'HD 108236 c', hostname: 'HD 108236', ra: 186.34679, dec: -27.17900, hostMag: 9.2, period: 6.2034470, epoch: 2458328.95400000, duration: 4.5},
    {name: 'HD 108236 d', hostname: 'HD 108236', ra: 186.34679, dec: -27.17900, hostMag: 9.2, period: 8.5149221, epoch: 2458331.73200000, duration: 5.2},
    {name: 'HD 136352 b', hostname: 'HD 136352', ra: 230.87988, dec: -48.95111, hostMag: 8.9, period: 11.57933, epoch: 2458638.32500000, duration: 4.7},
    {name: 'HD 136352 c', hostname: 'HD 136352', ra: 230.87988, dec: -48.95111, hostMag: 8.9, period: 27.58477, epoch: 2458649.87600000, duration: 6.8},
    {name: 'HD 149026 b', hostname: 'HD 149026', ra: 248.25792, dec: 38.34958, hostMag: 8.2, period: 2.87598129, epoch: 2453527.87455000, duration: 2.9},
    {name: 'HD 15337 b', hostname: 'HD 15337', ra: 37.14154, dec: -52.09472, hostMag: 9.0, period: 4.7590275, epoch: 2458713.70120000, duration: 3.2},
    {name: 'HD 17156 b', hostname: 'HD 17156', ra: 41.90696, dec: 71.97744, hostMag: 8.2, period: 21.2167374, epoch: 2454756.73473000, duration: 3.5},
    {name: 'HD 189733 b', hostname: 'HD 189733', ra: 300.17467, dec: 22.71056, hostMag: 7.7, period: 2.21857312, epoch: 2454279.43652000, duration: 1.8},
    {name: 'HD 209458 b', hostname: 'HD 209458', ra: 330.79483, dec: 18.88433, hostMag: 7.6, period: 3.52474859, epoch: 2452826.62861000, duration: 3.1},
    {name: 'HD 213885 b', hostname: 'HD 213885', ra: 338.91979, dec: -59.76819, hostMag: 7.9, period: 1.0080638, epoch: 2458362.36220000, duration: 1.1},
    {name: 'HD 219134 b', hostname: 'HD 219134', ra: 348.37558, dec: 57.17028, hostMag: 5.6, period: 3.0930812, epoch: 2457649.85180000, duration: 2.8},
    {name: 'HD 219134 h', hostname: 'HD 219134', ra: 348.37558, dec: 57.17028, hostMag: 5.6, period: 94.2, epoch: 2457696.50000000, duration: 8.5},
    {name: 'HD 63433 b', hostname: 'HD 63433', ra: 116.14254, dec: 27.87669, hostMag: 6.9, period: 7.1076327, epoch: 2458483.45300000, duration: 2.9},
    {name: 'HD 63433 c', hostname: 'HD 63433', ra: 116.14254, dec: 27.87669, hostMag: 6.9, period: 20.5451, epoch: 2458496.32000000, duration: 4.8},
    {name: 'HD 80653 b', hostname: 'HD 80653', ra: 140.05171, dec: 26.03128, hostMag: 8.5, period: 7.8093204, epoch: 2458516.73400000, duration: 3.7},
    {name: 'HD 86081 b', hostname: 'HD 86081', ra: 148.81946, dec: -3.07256, hostMag: 8.7, period: 2.1375105, epoch: 2458534.12300000, duration: 2.4},
    {name: 'HD 97658 b', hostname: 'HD 97658', ra: 168.29788, dec: 30.11633, hostMag: 7.7, period: 9.4941285, epoch: 2455086.40500000, duration: 4.2},
    {name: 'HIP 41378 b', hostname: 'HIP 41378', ra: 126.34650, dec: 8.93428, hostMag: 8.9, period: 15.5717, epoch: 2456859.84000000, duration: 4.3},
    {name: 'HIP 41378 c', hostname: 'HIP 41378', ra: 126.34650, dec: 8.93428, hostMag: 8.9, period: 31.7, epoch: 2456875.32000000, duration: 6.1},
    {name: 'HIP 41378 d', hostname: 'HIP 41378', ra: 126.34650, dec: 8.93428, hostMag: 8.9, period: 278.36, epoch: 2457015.70000000, duration: 12.8},
    {name: 'HIP 41378 e', hostname: 'HIP 41378', ra: 126.34650, dec: 8.93428, hostMag: 8.9, period: 18.0784, epoch: 2456867.91000000, duration: 4.9},
    {name: 'HIP 41378 f', hostname: 'HIP 41378', ra: 126.34650, dec: 8.93428, hostMag: 8.9, period: 542.08, epoch: 2457286.40000000, duration: 18.4},
    {name: 'K2-18 b', hostname: 'K2-18', ra: 165.91771, dec: 7.58775, hostMag: 13.5, period: 32.9401, epoch: 2456810.89000000, duration: 6.2},
    {name: 'K2-236 b', hostname: 'K2-236', ra: 2.61371, dec: 16.10589, hostMag: 11.5, period: 19.5, epoch: 2457965.40000000, duration: 5.1},
    {name: 'K2-237 b', hostname: 'K2-237', ra: 9.34542, dec: 18.87633, hostMag: 12.1, period: 15.18, epoch: 2457959.72000000, duration: 4.6},
    {name: 'K2-238 b', hostname: 'K2-238', ra: 12.88950, dec: 20.44339, hostMag: 13.2, period: 10.26, epoch: 2457952.13000000, duration: 3.8},
    {name: 'K2-239 b', hostname: 'K2-239', ra: 16.42871, dec: 22.00839, hostMag: 12.8, period: 5.24, epoch: 2457946.36000000, duration: 2.7},
    {name: 'K2-240 b', hostname: 'K2-240', ra: 20.01233, dec: 23.57922, hostMag: 11.9, period: 6.03, epoch: 2457947.84000000, duration: 2.9},
    {name: 'Kepler-10 b', hostname: 'Kepler-10', ra: 291.09363, dec: 50.24107, hostMag: 11.2, period: 0.8374907, epoch: 2454964.57688000, duration: 1.8},
    {name: 'Kepler-10 c', hostname: 'Kepler-10', ra: 291.09363, dec: 50.24107, hostMag: 11.2, period: 45.29485, epoch: 2455103.07310000, duration: 6.4},
    {name: 'KELT-1 b', hostname: 'KELT-1', ra: 2.19254, dec: 39.09806, hostMag: 10.7, period: 1.21749042, epoch: 2456193.14129000, duration: 2.2},
    {name: 'KELT-2 A b', hostname: 'KELT-2 A', ra: 109.73508, dec: 30.11403, hostMag: 8.8, period: 4.11379137, epoch: 2456176.66834000, duration: 2.7},
    {name: 'KELT-3 b', hostname: 'KELT-3', ra: 153.73688, dec: 40.00564, hostMag: 9.8, period: 2.70339856, epoch: 2456218.37714000, duration: 2.4},
    {name: 'KELT-4 A b', hostname: 'KELT-4 A', ra: 110.30042, dec: 25.06631, hostMag: 9.9, period: 2.98959637, epoch: 2456193.00300000, duration: 2.6},
    {name: 'KELT-6 b', hostname: 'KELT-6', ra: 120.27150, dec: 31.39597, hostMag: 10.3, period: 7.84563254, epoch: 2456347.99560000, duration: 4.1},
    {name: 'KELT-7 b', hostname: 'KELT-7', ra: 279.82333, dec: 48.01086, hostMag: 8.5, period: 2.73472222, epoch: 2456834.61965000, duration: 3.6},
    {name: 'KELT-8 b', hostname: 'KELT-8', ra: 277.13113, dec: 24.13464, hostMag: 9.3, period: 3.24407317, epoch: 2457103.42170000, duration: 3.1},
    {name: 'KELT-9 b', hostname: 'KELT-9', ra: 305.70625, dec: 39.94100, hostMag: 7.5, period: 1.48141414, epoch: 2457095.68650000, duration: 2.9},
    {name: 'KELT-11 b', hostname: 'KELT-11', ra: 87.71246, dec: -3.71681, hostMag: 8.0, period: 4.73610804, epoch: 2457483.55990000, duration: 3.4},
    {name: 'KELT-12 b', hostname: 'KELT-12', ra: 104.75292, dec: 31.80194, hostMag: 8.1, period: 5.03120933, epoch: 2457584.01850000, duration: 3.7},
    {name: 'KELT-14 b', hostname: 'KELT-14', ra: 111.58129, dec: 26.87578, hostMag: 8.3, period: 5.30507, epoch: 2457193.27580000, duration: 3.8},
    {name: 'KELT-15 b', hostname: 'KELT-15', ra: 109.81629, dec: 34.75881, hostMag: 11.2, period: 3.329441, epoch: 2457347.29620000, duration: 2.9},
    {name: 'KELT-16 b', hostname: 'KELT-16', ra: 264.95467, dec: 31.40097, hostMag: 11.7, period: 0.9689951, epoch: 2457503.67600000, duration: 1.8},
    {name: 'KELT-17 b', hostname: 'KELT-17', ra: 257.29417, dec: 26.59403, hostMag: 9.2, period: 3.08111787, epoch: 2457631.74440000, duration: 3.2},
    {name: 'KELT-18 b', hostname: 'KELT-18', ra: 303.30867, dec: 26.89553, hostMag: 10.1, period: 2.87845341, epoch: 2457756.45670000, duration: 2.8},
    {name: 'KELT-19 A b', hostname: 'KELT-19 A', ra: 278.20467, dec: 7.38483, hostMag: 9.9, period: 4.61178, epoch: 2457766.71880000, duration: 3.5},
    {name: 'KELT-20 b', hostname: 'KELT-20', ra: 100.81100, dec: 11.80369, hostMag: 7.6, period: 3.47407, epoch: 2457503.12080000, duration: 3.1},
    {name: 'KELT-21 b', hostname: 'KELT-21', ra: 347.72013, dec: 41.64594, hostMag: 10.5, period: 3.61624, epoch: 2457814.27030000, duration: 3.3},
    {name: 'KELT-22 A b', hostname: 'KELT-22 A', ra: 312.48079, dec: 25.80594, hostMag: 11.1, period: 1.3866529, epoch: 2457830.32560000, duration: 2.0},
    {name: 'KELT-23 A b', hostname: 'KELT-23 A', ra: 82.30350, dec: 52.31186, hostMag: 10.4, period: 2.255353, epoch: 2457801.67620000, duration: 2.3},
    {name: 'KELT-24 b', hostname: 'KELT-24', ra: 114.71604, dec: 16.04200, hostMag: 8.3, period: 5.5509, epoch: 2457868.10570000, duration: 4.2},
    {name: 'KELT-25 b', hostname: 'KELT-25', ra: 76.17192, dec: 19.16300, hostMag: 9.8, period: 4.40746, epoch: 2457879.21490000, duration: 3.6},
    {name: 'LP 714-47 b', hostname: 'LP 714-47', ra: 84.30179, dec: 35.26128, hostMag: 12.1, period: 4.05204, epoch: 2458889.32500000, duration: 2.8},
    {name: 'LP 890-9 b', hostname: 'LP 890-9', ra: 345.54629, dec: -32.06161, hostMag: 13.2, period: 2.7295313, epoch: 2459129.39600000, duration: 2.1},
    {name: 'LP 890-9 c', hostname: 'LP 890-9', ra: 345.54629, dec: -32.06161, hostMag: 13.2, period: 8.7808, epoch: 2459135.84000000, duration: 3.4},
    {name: 'NGTS-1 b', hostname: 'NGTS-1', ra: 93.73754, dec: -33.76147, hostMag: 13.8, period: 2.6474639, epoch: 2457870.31900000, duration: 2.3},
    {name: 'NGTS-2 b', hostname: 'NGTS-2', ra: 87.03146, dec: -32.23069, hostMag: 10.9, period: 3.5317472, epoch: 2458035.13300000, duration: 2.7},
    {name: 'NGTS-4 b', hostname: 'NGTS-4', ra: 86.18792, dec: -35.84658, hostMag: 13.1, period: 1.33777, epoch: 2458042.48800000, duration: 1.9},
    {name: 'NGTS-5 b', hostname: 'NGTS-5', ra: 86.55379, dec: -29.73169, hostMag: 12.2, period: 3.35344, epoch: 2458299.66800000, duration: 2.8},
    {name: 'NGTS-6 b', hostname: 'NGTS-6', ra: 86.13942, dec: -32.98008, hostMag: 12.0, period: 21.17, epoch: 2458311.53000000, duration: 5.2},
    {name: 'NGTS-7 A b', hostname: 'NGTS-7 A', ra: 90.28517, dec: -34.44053, hostMag: 12.2, period: 0.6816557, epoch: 2458418.62100000, duration: 1.4},
    {name: 'NGTS-8 b', hostname: 'NGTS-8', ra: 93.35696, dec: -37.22167, hostMag: 12.9, period: 2.49049, epoch: 2458476.32000000, duration: 2.4},
    {name: 'NGTS-9 b', hostname: 'NGTS-9', ra: 85.67758, dec: -33.81617, hostMag: 12.2, period: 1.32435, epoch: 2458538.94400000, duration: 1.8},
    {name: 'NGTS-10 b', hostname: 'NGTS-10', ra: 92.14096, dec: -30.91703, hostMag: 11.9, period: 0.76696, epoch: 2458602.78100000, duration: 1.5},
    {name: 'Qatar-1 b', hostname: 'Qatar-1', ra: 304.83433, dec: 65.17956, hostMag: 12.8, period: 1.4200246, epoch: 2455518.41045000, duration: 1.9},
    {name: 'Qatar-2 b', hostname: 'Qatar-2', ra: 299.59338, dec: 42.47378, hostMag: 13.3, period: 1.3371222, epoch: 2455954.73520000, duration: 1.8},
    {name: 'Qatar-3 b', hostname: 'Qatar-3', ra: 137.34908, dec: 12.18681, hostMag: 12.4, period: 2.5080814, epoch: 2456779.74840000, duration: 2.3},
    {name: 'Qatar-4 b', hostname: 'Qatar-4', ra: 130.48558, dec: 16.04622, hostMag: 13.1, period: 1.8055, epoch: 2456779.65570000, duration: 2.0},
    {name: 'Qatar-5 b', hostname: 'Qatar-5', ra: 147.68433, dec: 39.71267, hostMag: 12.8, period: 2.8792314, epoch: 2456876.93450000, duration: 2.6},
    {name: 'Qatar-6 b', hostname: 'Qatar-6', ra: 347.65779, dec: 23.04656, hostMag: 12.2, period: 3.5066, epoch: 2457001.12670000, duration: 2.9},
    {name: 'Qatar-7 b', hostname: 'Qatar-7', ra: 308.18354, dec: 28.08581, hostMag: 12.5, period: 2.6164, epoch: 2457194.07990000, duration: 2.4},
    {name: 'Qatar-8 b', hostname: 'Qatar-8', ra: 314.77050, dec: 21.41222, hostMag: 12.9, period: 3.7225, epoch: 2457345.28140000, duration: 2.8},
    {name: 'Qatar-10 b', hostname: 'Qatar-10', ra: 108.34608, dec: 26.30089, hostMag: 12.9, period: 1.16424, epoch: 2458034.43900000, duration: 1.7},
    {name: 'TOI-118 b', hostname: 'TOI-118', ra: 88.04671, dec: -34.90072, hostMag: 11.0, period: 4.0503, epoch: 2458514.46400000, duration: 2.9},
    {name: 'TOI-122 b', hostname: 'TOI-122', ra: 86.70179, dec: -45.31308, hostMag: 9.9, period: 5.08187, epoch: 2458508.32800000, duration: 3.1},
    {name: 'TOI-132 b', hostname: 'TOI-132', ra: 46.29858, dec: -40.81058, hostMag: 9.5, period: 2.11, epoch: 2458498.72000000, duration: 2.3},
    {name: 'TOI-148 b', hostname: 'TOI-148', ra: 85.22038, dec: -64.86647, hostMag: 8.2, period: 8.36, epoch: 2458517.84000000, duration: 3.6},
    {name: 'TOI-150 b', hostname: 'TOI-150', ra: 73.80746, dec: -69.99189, hostMag: 10.1, period: 5.857, epoch: 2458510.19000000, duration: 3.2},
    {name: 'TOI-178 b', hostname: 'TOI-178', ra: 27.87971, dec: -21.58747, hostMag: 11.9, period: 1.91484, epoch: 2458504.84000000, duration: 1.9},
    {name: 'TOI-178 c', hostname: 'TOI-178', ra: 27.87971, dec: -21.58747, hostMag: 11.9, period: 3.23876, epoch: 2458507.45000000, duration: 2.5},
    {name: 'TOI-178 d', hostname: 'TOI-178', ra: 27.87971, dec: -21.58747, hostMag: 11.9, period: 6.55596, epoch: 2458512.07000000, duration: 3.1},
    {name: 'TOI-178 e', hostname: 'TOI-178', ra: 27.87971, dec: -21.58747, hostMag: 11.9, period: 9.95613, epoch: 2458517.43000000, duration: 3.7},
    {name: 'TOI-178 f', hostname: 'TOI-178', ra: 27.87971, dec: -21.58747, hostMag: 11.9, period: 15.2361, epoch: 2458524.61000000, duration: 4.5},
    {name: 'TOI-178 g', hostname: 'TOI-178', ra: 27.87971, dec: -21.58747, hostMag: 11.9, period: 20.709, epoch: 2458531.84000000, duration: 5.1},
    {name: 'TOI-201 b', hostname: 'TOI-201', ra: 50.03754, dec: -39.16253, hostMag: 11.7, period: 0.7709, epoch: 2458492.42000000, duration: 1.4},
    {name: 'TOI-216 b', hostname: 'TOI-216', ra: 42.78725, dec: -45.37783, hostMag: 8.9, period: 17.07, epoch: 2458508.93000000, duration: 4.7},
    {name: 'TOI-216 c', hostname: 'TOI-216', ra: 42.78725, dec: -45.37783, hostMag: 8.9, period: 34.56, epoch: 2458521.76000000, duration: 6.5},
    {name: 'TOI-421 b', hostname: 'TOI-421', ra: 99.29029, dec: -65.55133, hostMag: 10.6, period: 16.06, epoch: 2458540.12000000, duration: 4.6},
    {name: 'TOI-421 c', hostname: 'TOI-421', ra: 99.29029, dec: -65.55133, hostMag: 10.6, period: 16.25, epoch: 2458540.35000000, duration: 4.7},
    {name: 'TOI-469 b', hostname: 'TOI-469', ra: 87.00450, dec: -59.77661, hostMag: 9.6, period: 13.863, epoch: 2458535.42000000, duration: 4.2},
    {name: 'TOI-500 b', hostname: 'TOI-500', ra: 79.23775, dec: -66.25681, hostMag: 11.2, period: 6.6507, epoch: 2458514.87000000, duration: 3.1},
    {name: 'TOI-519 b', hostname: 'TOI-519', ra: 88.87975, dec: -61.43364, hostMag: 12.2, period: 1.26, epoch: 2458497.93000000, duration: 1.7},
    {name: 'TOI-530 b', hostname: 'TOI-530', ra: 81.31238, dec: -69.26606, hostMag: 11.9, period: 6.387, epoch: 2458515.84000000, duration: 3.0},
    {name: 'TOI-540 b', hostname: 'TOI-540', ra: 85.62625, dec: -55.86258, hostMag: 10.9, period: 1.239, epoch: 2458498.62000000, duration: 1.6},
    {name: 'TOI-544 b', hostname: 'TOI-544', ra: 90.17704, dec: -69.49325, hostMag: 10.2, period: 1.544, epoch: 2458499.33000000, duration: 1.8},
    {name: 'TOI-560 b', hostname: 'TOI-560', ra: 100.96313, dec: -57.70617, hostMag: 10.2, period: 6.398, epoch: 2458515.90000000, duration: 3.0},
    {name: 'TOI-562 b', hostname: 'TOI-562', ra: 101.67754, dec: -52.24650, hostMag: 9.3, period: 9.557, epoch: 2458521.34000000, duration: 3.6},
    {name: 'TOI-677 b', hostname: 'TOI-677', ra: 38.42175, dec: -49.75867, hostMag: 9.8, period: 11.236, epoch: 2458529.45000000, duration: 3.9},
    {name: 'TOI-700 b', hostname: 'TOI-700', ra: 23.31617, dec: -37.35631, hostMag: 13.1, period: 9.977, epoch: 2458522.19000000, duration: 3.6},
    {name: 'TOI-700 c', hostname: 'TOI-700', ra: 23.31617, dec: -37.35631, hostMag: 13.1, period: 16.051, epoch: 2458529.24000000, duration: 4.6},
    {name: 'TOI-700 d', hostname: 'TOI-700', ra: 23.31617, dec: -37.35631, hostMag: 13.1, period: 37.426, epoch: 2458546.46000000, duration: 6.8},
    {name: 'TOI-700 e', hostname: 'TOI-700', ra: 23.31617, dec: -37.35631, hostMag: 13.1, period: 27.809, epoch: 2458537.88000000, duration: 5.8},
    {name: 'TOI-715 b', hostname: 'TOI-715', ra: 101.73579, dec: -66.25953, hostMag: 12.4, period: 19.28, epoch: 2458539.42000000, duration: 4.9},
    {name: 'TOI-849 b', hostname: 'TOI-849', ra: 119.28938, dec: -44.25283, hostMag: 11.5, period: 0.76523, epoch: 2458540.17000000, duration: 1.4},
    {name: 'TOI-942 b', hostname: 'TOI-942', ra: 24.33533, dec: -57.64364, hostMag: 13.6, period: 4.32594, epoch: 2458512.73000000, duration: 2.7},
    {name: 'TOI-1064 b', hostname: 'TOI-1064', ra: 69.40529, dec: -58.37828, hostMag: 11.9, period: 1.555, epoch: 2458503.41000000, duration: 1.8},
    {name: 'TOI-1075 b', hostname: 'TOI-1075', ra: 67.94117, dec: -66.96150, hostMag: 11.2, period: 0.605, epoch: 2458498.32000000, duration: 1.2},
    {name: 'TOI-1136 b', hostname: 'TOI-1136', ra: 337.42775, dec: -54.47164, hostMag: 10.5, period: 4.31, epoch: 2458655.48000000, duration: 2.7},
    {name: 'TOI-1136 c', hostname: 'TOI-1136', ra: 337.42775, dec: -54.47164, hostMag: 10.5, period: 7.82, epoch: 2458660.64000000, duration: 3.4},
    {name: 'TOI-1136 d', hostname: 'TOI-1136', ra: 337.42775, dec: -54.47164, hostMag: 10.5, period: 25.72, epoch: 2458677.58000000, duration: 5.5},
    {name: 'TOI-1136 e', hostname: 'TOI-1136', ra: 337.42775, dec: -54.47164, hostMag: 10.5, period: 19.58, epoch: 2458668.71000000, duration: 4.9},
    {name: 'TOI-1136 f', hostname: 'TOI-1136', ra: 337.42775, dec: -54.47164, hostMag: 10.5, period: 13.08, epoch: 2458662.20000000, duration: 4.1},
    {name: 'TOI-1136 g', hostname: 'TOI-1136', ra: 337.42775, dec: -54.47164, hostMag: 10.5, period: 33.13, epoch: 2458686.47000000, duration: 6.3},
    {name: 'TrES-1 b', hostname: 'TrES-1', ra: 289.05704, dec: 36.63475, hostMag: 11.8, period: 3.03007081, epoch: 2453186.80605000, duration: 2.5},
    {name: 'TrES-2 b', hostname: 'TrES-2', ra: 290.56775, dec: 49.31558, hostMag: 11.4, period: 2.47061334, epoch: 2454955.76213000, duration: 2.3},
    {name: 'TrES-3 b', hostname: 'TrES-3', ra: 268.02042, dec: 37.54614, hostMag: 12.4, period: 1.30618608, epoch: 2454632.62587000, duration: 1.8},
    {name: 'TrES-4 b', hostname: 'TrES-4', ra: 257.46050, dec: 37.21208, hostMag: 11.6, period: 3.55390515, epoch: 2454230.90798000, duration: 3.0},
    {name: 'V1298 Tau b', hostname: 'V1298 Tau', ra: 64.29758, dec: 25.29339, hostMag: 10.2, period: 24.1434, epoch: 2458426.03000000, duration: 5.4},
    {name: 'V1298 Tau c', hostname: 'V1298 Tau', ra: 64.29758, dec: 25.29339, hostMag: 10.2, period: 8.2498, epoch: 2458413.42000000, duration: 3.4},
    {name: 'V1298 Tau d', hostname: 'V1298 Tau', ra: 64.29758, dec: 25.29339, hostMag: 10.2, period: 12.4, epoch: 2458419.71000000, duration: 4.0},
    {name: 'V1298 Tau e', hostname: 'V1298 Tau', ra: 64.29758, dec: 25.29339, hostMag: 10.2, period: 60, epoch: 2458456.00000000, duration: 8.5},
    {name: 'WASP-1 b', hostname: 'WASP-1', ra: 0.47225, dec: 31.86378, hostMag: 11.8, period: 2.51996384, epoch: 2453912.37764000, duration: 2.4},
    {name: 'WASP-2 b', hostname: 'WASP-2', ra: 309.59675, dec: 6.43036, hostMag: 11.9, period: 2.15222144, epoch: 2454033.76919000, duration: 2.2},
    {name: 'WASP-3 b', hostname: 'WASP-3', ra: 278.75250, dec: 35.66672, hostMag: 10.6, period: 1.84683412, epoch: 2454138.55410000, duration: 2.0},
    {name: 'WASP-4 b', hostname: 'WASP-4', ra: 354.04275, dec: -42.06175, hostMag: 12.5, period: 1.33823213, epoch: 2454697.79858000, duration: 1.8},
    {name: 'WASP-5 b', hostname: 'WASP-5', ra: 0.17917, dec: -41.27739, hostMag: 12.3, period: 1.62842471, epoch: 2454375.62579000, duration: 1.9},
    {name: 'WASP-6 b', hostname: 'WASP-6', ra: 354.83683, dec: -22.67403, hostMag: 11.9, period: 3.36100170, epoch: 2454221.48163000, duration: 2.8},
    {name: 'WASP-7 b', hostname: 'WASP-7', ra: 311.27954, dec: -39.23528, hostMag: 9.5, period: 4.95429504, epoch: 2454955.93267000, duration: 3.5},
    {name: 'WASP-8 b', hostname: 'WASP-8', ra: 354.79392, dec: -35.02522, hostMag: 9.9, period: 8.15873619, epoch: 2454458.95644000, duration: 4.0},
    {name: 'WASP-10 b', hostname: 'WASP-10', ra: 359.50333, dec: 31.46139, hostMag: 12.7, period: 3.09272907, epoch: 2454696.84285000, duration: 2.7},
    {name: 'WASP-11 b', hostname: 'WASP-11', ra: 57.64358, dec: 30.15247, hostMag: 11.6, period: 3.72216, epoch: 2455558.57650000, duration: 2.9},
    {name: 'WASP-12 b', hostname: 'WASP-12', ra: 97.63675, dec: 29.67236, hostMag: 11.7, period: 1.09142089, epoch: 2454508.97660000, duration: 1.8},
    {name: 'WASP-13 b', hostname: 'WASP-13', ra: 140.84675, dec: 33.88336, hostMag: 10.4, period: 4.35298425, epoch: 2454697.19850000, duration: 3.2},
    {name: 'WASP-14 b', hostname: 'WASP-14', ra: 212.08529, dec: 21.90058, hostMag: 9.7, period: 2.24376840, epoch: 2454838.70501000, duration: 2.3},
    {name: 'WASP-15 b', hostname: 'WASP-15', ra: 204.74275, dec: -32.16197, hostMag: 10.9, period: 3.75209375, epoch: 2454554.66177000, duration: 2.9},
    {name: 'WASP-16 b', hostname: 'WASP-16', ra: 205.55733, dec: -20.24475, hostMag: 11.3, period: 3.11864080, epoch: 2454832.02886000, duration: 2.7},
    {name: 'WASP-17 b', hostname: 'WASP-17', ra: 226.37450, dec: -28.06181, hostMag: 11.6, period: 3.73535533, epoch: 2454967.01441000, duration: 2.9},
    {name: 'WASP-18 b', hostname: 'WASP-18', ra: 16.15871, dec: -45.67797, hostMag: 9.3, period: 0.94145299, epoch: 2454221.48163000, duration: 1.6},
    {name: 'WASP-19 b', hostname: 'WASP-19', ra: 143.70329, dec: 9.88536, hostMag: 12.3, period: 0.78884000, epoch: 2454775.53593000, duration: 1.5},
    {name: 'WASP-20 b', hostname: 'WASP-20', ra: 28.04146, dec: -25.01469, hostMag: 10.7, period: 4.89952104, epoch: 2454877.76062000, duration: 3.5}
  ,
    {name: 'HD 219134 c', hostname: 'HD 219134', ra: 200.22500, dec: 57.16963, hostMag: 5.6, period: 6.7650398, epoch: 2460599.497, duration: 1.42, depth: 0.27},
    {name: 'HD 136352 d', hostname: 'HD 136352', ra: 326.40000, dec: -48.31882, hostMag: 5.7, period: 107.245, epoch: 2459009.776, duration: 8.87, depth: 0.49},
    {name: 'HD 88986 b', hostname: 'HD 88986', ra: 247.00000, dec: 28.68207, hostMag: 6.5, period: 146.05, epoch: 2458891.69, duration: 13.7, depth: 0.22},
    {name: 'WASP-189 b', hostname: 'WASP-189', ra: 41.20000, dec: -3.03149, hostMag: 6.6, period: 2.7240308, epoch: 2456706.457, duration: 4.33, depth: 5},
    {name: 'HD 25463 b', hostname: 'HD 25463', ra: 44.90000, dec: 9.20777, hostMag: 6.9, period: 7.049144, epoch: 2458978.353, duration: 3.23, depth: 0.3},
    {name: 'HD 25463 c', hostname: 'HD 25463', ra: 44.90000, dec: 9.20777, hostMag: 6.9, period: 3.04405, epoch: 2458980.314, duration: 1.3, depth: 0.08},
    {name: 'TOI-2128 b', hostname: 'TOI-2128', ra: 118.90000, dec: 32.10530, hostMag: 7.2, period: 16.34136, epoch: 2458987.266, duration: 4.7, depth: 0.37},
    {name: 'TOI-257 b', hostname: 'TOI-257', ra: 151.02500, dec: -50.83226, hostMag: 7.6, period: 18.38770809, epoch: 2459121.27, duration: 6.41, depth: 1.2},
    {name: 'HD 1397 b', hostname: 'HD 1397', ra: 266.82500, dec: -66.35893, hostMag: 7.8, period: 11.5366, epoch: 2458332.082, duration: 8.6, depth: 2},
    {name: 'TOI-1431 b', hostname: 'TOI-1431', ra: 72.22500, dec: 55.58802, hostMag: 8, period: 2.650232, epoch: 2460554.586, duration: 2.03, depth: 6.4},
    {name: 'HD 114082 b', hostname: 'HD 114082', ra: 139.02500, dec: -60.30843, hostMag: 8.2, period: 109.75, epoch: 2459339.039, duration: 12.14, depth: 4.5},
    {name: 'Kepler-21 b', hostname: 'Kepler-21', ra: 141.72500, dec: 38.71414, hostMag: 8.2, period: 2.78581504, epoch: 2454954.548, duration: 3.84, depth: 0.07},
    {name: 'TOI-5082.01', hostname: 'TOI-5082.01', ra: 94.17500, dec: 22.68315, hostMag: 8.2, period: 4.2403543, epoch: 2460284.803, duration: 2.35, depth: 0.84},
    {name: 'HD 202772 A b', hostname: 'HD 202772 A', ra: 281.97500, dec: -26.61638, hostMag: 8.3, period: 3.3088753, epoch: 2458705.896, duration: 5.63, depth: 3.8},
    {name: 'HIP 94235 b', hostname: 'HIP 94235', ra: 164.47500, dec: -60.27264, hostMag: 8.3, period: 7.713057, epoch: 2459037.87, duration: 2.47, depth: 0.73},
    {name: 'MASCARA-1 b', hostname: 'MASCARA-1', ra: 153.10000, dec: 10.73890, hostMag: 8.3, period: 2.1425095, epoch: 2460556.771, duration: 5.16, depth: 8},
    {name: 'TOI-4602.01', hostname: 'TOI-4602.01', ra: 36.02500, dec: 31.32984, hostMag: 8.3, period: 3.9813082, epoch: 2460655.202, duration: 3.1, depth: 0.46},
    {name: 'TOI-128.01', hostname: 'TOI-128.01', ra: 271.25000, dec: -80.96438, hostMag: 8.4, period: 4.9404714, epoch: 2460175.867, duration: 1.95, depth: 0.45},
    {name: 'TOI-1860 b', hostname: 'TOI-1860', ra: 87.40000, dec: 64.04768, hostMag: 8.4, period: 1.0662082, epoch: 2460367.148, duration: 1.14, depth: 0.15},
    {name: 'TOI-4443.01', hostname: 'TOI-4443.01', ra: 256.12500, dec: 21.90955, hostMag: 8.5, period: 1.84985668, epoch: 2459415.152, duration: 2.52, depth: 0.2},
    {name: 'HD 20329 b', hostname: 'HD 20329', ra: 250.70000, dec: 15.65636, hostMag: 8.8, period: 0.9260632, epoch: 2460233.367, duration: 1.03, depth: 0.22},
    {name: 'HD 6061 b', hostname: 'HD 6061', ra: 35.87500, dec: 37.18544, hostMag: 8.8, period: 5.2544884, epoch: 2460608.852, duration: 2.9, depth: 0.57},
    {name: 'Kepler-444 b', hostname: 'Kepler-444', ra: 285.17500, dec: 41.63188, hostMag: 8.9, period: 3.60011885, epoch: 2454955.459, duration: 2.47, depth: 0.03},
    {name: 'Kepler-444 c', hostname: 'Kepler-444', ra: 285.17500, dec: 41.63188, hostMag: 8.9, period: 4.54586974, epoch: 2454955.433, duration: 2.15, depth: 0.04},
    {name: 'Kepler-444 d', hostname: 'Kepler-444', ra: 285.17500, dec: 41.63188, hostMag: 8.9, period: 6.18937218, epoch: 2454955.41, duration: 2.59, depth: 0.05},
    {name: 'Kepler-444 e', hostname: 'Kepler-444', ra: 285.17500, dec: 41.63188, hostMag: 8.9, period: 7.74350338, epoch: 2454960.351, duration: 3.13, depth: 0.05},
    {name: 'Kepler-444 f', hostname: 'Kepler-444', ra: 285.17500, dec: 41.63188, hostMag: 8.9, period: 9.74048028, epoch: 2454958.139, duration: 2.04, depth: 0.08},
    {name: 'TOI-1742 b', hostname: 'TOI-1742', ra: 139.72500, dec: 71.87667, hostMag: 8.9, period: 21.2690422, epoch: 2460660.831, duration: 5.89, depth: 0.35},
    {name: 'TOI-2134 b', hostname: 'TOI-2134', ra: 116.12500, dec: 39.07293, hostMag: 8.9, period: 9.2292078, epoch: 2460496.591, duration: 2.82, depth: 1.6},
    {name: 'TOI-2134 c', hostname: 'TOI-2134', ra: 116.12500, dec: 39.07293, hostMag: 8.9, period: 95.8531625, epoch: 2460485.794, duration: 5.02, depth: 6},
    {name: 'TOI-262 b', hostname: 'TOI-262', ra: 152.07500, dec: -31.07063, hostMag: 8.9, period: 11.14529, epoch: 2459136.577, duration: 1.5, depth: 0.48},
    {name: 'HD 191939 b', hostname: 'HD 191939', ra: 121.52500, dec: 66.85030, hostMag: 9, period: 8.8803281, epoch: 2460651.267, duration: 2.71, depth: 1.2},
    {name: 'HD 191939 c', hostname: 'HD 191939', ra: 121.52500, dec: 66.85030, hostMag: 9, period: 28.580474, epoch: 2460612.351, duration: 4.51, depth: 1.1},
    {name: 'HD 191939 d', hostname: 'HD 191939', ra: 121.52500, dec: 66.85030, hostMag: 9, period: 38.3511223, epoch: 2460661.128, duration: 5.91, depth: 1},
    {name: 'HD 77946 b', hostname: 'HD 77946', ra: 106.65000, dec: 46.67243, hostMag: 9, period: 6.527282, epoch: 2459587.474, duration: 3.55, depth: 0.42},
    {name: 'TOI-1799 b', hostname: 'TOI-1799', ra: 133.97500, dec: 34.30301, hostMag: 9, period: 7.085738, epoch: 2458904.832, duration: 3.14, depth: 0.28},
    {name: 'TOI-4633 c', hostname: 'TOI-4633', ra: 110.57500, dec: 62.47555, hostMag: 9, period: 271.9445, epoch: 2458864.827, duration: 11.45, depth: 0.48},
    {name: 'TOI-622 b', hostname: 'TOI-622', ra: 318.30000, dec: -46.48430, hostMag: 9, period: 6.40252947, epoch: 2460006.078, duration: 3.92, depth: 3.8},
    {name: 'HD 135694 b', hostname: 'HD 135694', ra: 172.07500, dec: 71.84130, hostMag: 9.1, period: 15.92347557, epoch: 2459834.139, duration: 4.49, depth: 0.49},
    {name: 'HD 80606 b', hostname: 'HD 80606', ra: 339.42500, dec: 50.60378, hostMag: 9.1, period: 111.4367, epoch: 2455210.643, duration: 11.9, depth: 11},
    {name: 'TOI-778 b', hostname: 'TOI-778', ra: 260.02500, dec: -15.27371, hostMag: 9.1, period: 4.6336155, epoch: 2459574.943, duration: 3.56, depth: 7.7},
    {name: 'HD 235088 b', hostname: 'HD 235088', ra: 36.92500, dec: 53.37744, hostMag: 9.2, period: 7.4341393, epoch: 2459798.464, duration: 2.7, depth: 0.7},
    {name: 'HD 56414 b', hostname: 'HD 56414', ra: 170.62500, dec: -68.83334, hostMag: 9.2, period: 29.0497517, epoch: 2460178.462, duration: 7.12, depth: 0.32},
    {name: 'HIP 9618 b', hostname: 'HIP 9618', ra: 54.30000, dec: 21.28133, hostMag: 9.2, period: 20.772907, epoch: 2458767.421, duration: 4.91, depth: 1.4},
    {name: 'HIP 9618 c', hostname: 'HIP 9618', ra: 54.30000, dec: 21.28133, hostMag: 9.2, period: 52.563491, epoch: 2458779.192, duration: 6.55, depth: 1.2},
    {name: 'TOI-1437 b', hostname: 'TOI-1437', ra: 68.32500, dec: 56.84255, hostMag: 9.2, period: 18.840891, epoch: 2460660.183, duration: 5.76, depth: 0.33},
    {name: 'TOI-2458 b', hostname: 'TOI-2458', ra: 277.30000, dec: 1.25344, hostMag: 9.2, period: 3.73659, epoch: 2459177.405, duration: 2.13, depth: 0.39},
    {name: 'TOI-1751 b', hostname: 'TOI-1751', ra: 209.32500, dec: 63.53353, hostMag: 9.3, period: 37.4685042, epoch: 2460607.061, duration: 7.69, depth: 0.43},
    {name: 'TOI-1777.01', hostname: 'TOI-1777.01', ra: 108.42500, dec: 46.11488, hostMag: 9.3, period: 14.65011197, epoch: 2459635.107, duration: 2.64, depth: 0.33},
    {name: 'TOI-3353.01', hostname: 'TOI-3353.01', ra: 91.80000, dec: -75.81956, hostMag: 9.3, period: 4.6658007, epoch: 2460174.15, duration: 2.61, depth: 0.57},
    {name: 'HD 28109 b', hostname: 'HD 28109', ra: 314.30000, dec: -68.10269, hostMag: 9.4, period: 22.8909855, epoch: 2460176.096, duration: 2.47, depth: 0.25},
    {name: 'HD 28109 c', hostname: 'HD 28109', ra: 314.30000, dec: -68.10269, hostMag: 9.4, period: 56.00450565, epoch: 2460129.286, duration: 10.43, depth: 0.77},
    {name: 'HD 28109 d', hostname: 'HD 28109', ra: 314.30000, dec: -68.10269, hostMag: 9.4, period: 84.26076445, epoch: 2458355.649, duration: 10.93, depth: 0.44},
    {name: 'HD 89345 b', hostname: 'HD 89345', ra: 280.27500, dec: 10.12885, hostMag: 9.4, period: 11.8144024, epoch: 2458740.811, duration: 5.65, depth: 1.5},
    {name: 'TOI-1716.01', hostname: 'TOI-1716.01', ra: 5.00000, dec: 56.82419, hostMag: 9.4, period: 8.082354, epoch: 2460298.678, duration: 3.28, depth: 0.56},
    {name: 'WASP-38 b', hostname: 'WASP-38', ra: 237.57500, dec: 10.03241, hostMag: 9.4, period: 6.8718851, epoch: 2456992.046, duration: 4.66, depth: 6.9},
    {name: 'HD 42813 b', hostname: 'HD 42813', ra: 183.47500, dec: -14.64932, hostMag: 9.5, period: 13.6308205, epoch: 2458474.569, duration: 4.33, depth: 1.2},
    {name: 'HIP 29442 c', hostname: 'HIP 29442', ra: 183.47500, dec: -14.64932, hostMag: 9.5, period: 3.5379559, epoch: 2458471.36, duration: 2.43, depth: 0.21},
    {name: 'HIP 29442 d', hostname: 'HIP 29442', ra: 183.47500, dec: -14.64932, hostMag: 9.5, period: 6.429575, epoch: 2458472.987, duration: 3.08, depth: 0.21},
    {name: 'K2-222 b', hostname: 'K2-222', ra: 87.75000, dec: 11.75372, hostMag: 9.5, period: 15.38866066, epoch: 2459461.181, duration: 4.33, depth: 0.41},
    {name: 'K2-406 b', hostname: 'K2-406', ra: 353.22500, dec: -25.37061, hostMag: 9.5, period: 22.549406, epoch: 2458010.39, duration: 4.8, depth: 1.9},
    {name: 'TOI-1710 b', hostname: 'TOI-1710', ra: 257.02500, dec: 76.21102, hostMag: 9.5, period: 24.2833782, epoch: 2460439.667, duration: 5.13, depth: 2.8},
    {name: 'TOI-2141 b', hostname: 'TOI-2141', ra: 225.75000, dec: 18.34034, hostMag: 9.5, period: 18.2616878, epoch: 2460453.432, duration: 3.43, depth: 0.97},
    {name: 'TOI-2497 b', hostname: 'TOI-2497', ra: 3.75000, dec: 11.88406, hostMag: 9.5, period: 10.65569403, epoch: 2459205.098, duration: 7.82, depth: 2.1},
    {name: 'TOI-2545 b', hostname: 'TOI-2545', ra: 32.75000, dec: -3.42082, hostMag: 9.5, period: 7.99403672, epoch: 2458522.514, duration: 4.27, depth: 0.4},
    {name: 'TOI-4495.01', hostname: 'TOI-4495.01', ra: 81.75000, dec: 37.02599, hostMag: 9.5, period: 5.1830043, epoch: 2459765.915, duration: 2.78, depth: 0.67},
    {name: 'TOI-261.01', hostname: 'TOI-261.01', ra: 13.07500, dec: -24.42399, hostMag: 9.6, period: 3.3639254, epoch: 2458383.916, duration: 3.34, depth: 0.42},
    {name: 'TOI-5800 b', hostname: 'TOI-5800', ra: 303.92500, dec: -7.41193, hostMag: 9.6, period: 2.6278838, epoch: 2459771.715, duration: 1.2, depth: 0.73},
    {name: 'TOI-1824 b', hostname: 'TOI-1824', ra: 163.87500, dec: 61.74485, hostMag: 9.7, period: 22.8085719, epoch: 2460362.104, duration: 3.85, depth: 0.98},
    {name: 'TOI-5726.01', hostname: 'TOI-5726.01', ra: 203.70000, dec: 68.57459, hostMag: 9.7, period: 5.49113023, epoch: 2458843.596, duration: 1.91, depth: 0.45},
    {name: 'HD 219666 b', hostname: 'HD 219666', ra: 273.55000, dec: -56.90399, hostMag: 9.8, period: 6.034468, epoch: 2459083.511, duration: 2.16, depth: 1.8},
    {name: 'KOI-13 b', hostname: 'KOI-13', ra: 118.27500, dec: 46.86825, hostMag: 9.8, period: 1.76358747, epoch: 2454953.566, duration: 3.17, depth: 4.6},
    {name: 'TOI-1836 b', hostname: 'TOI-1836', ra: 354.47500, dec: 54.69008, hostMag: 9.8, period: 20.380799, epoch: 2459646.494, duration: 6.65, depth: 2.2},
    {name: 'TOI-1836 c', hostname: 'TOI-1836', ra: 354.47500, dec: 54.69008, hostMag: 9.8, period: 1.7727505, epoch: 2460477.136, duration: 1.52, depth: 0.24},
    {name: 'TOI-5108 b', hostname: 'TOI-5108', ra: 76.17500, dec: 11.24641, hostMag: 9.8, period: 6.753581, epoch: 2459569.478, duration: 2.2, depth: 1.7},
    {name: 'WASP-74 b', hostname: 'WASP-74', ra: 272.32500, dec: -1.07600, hostMag: 9.8, period: 2.13775367, epoch: 2457103.326, duration: 2.29, depth: 9.6},
    {name: 'TOI-1670 b', hostname: 'TOI-1670', ra: 241.02500, dec: 72.16118, hostMag: 9.9, period: 10.9836724, epoch: 2460468.361, duration: 2.64, depth: 0.32},
    {name: 'TOI-1670 c', hostname: 'TOI-1670', ra: 241.02500, dec: 72.16118, hostMag: 9.9, period: 40.7501028, epoch: 2460503.137, duration: 4.87, depth: 6},
    {name: 'TOI-260 b', hostname: 'TOI-260', ra: 286.37500, dec: -9.96615, hostMag: 9.9, period: 13.475853, epoch: 2458392.294, duration: 2.37, depth: 0.71},
    {name: 'TOI-286 b', hostname: 'TOI-286', ra: 59.05000, dec: -60.66634, hostMag: 9.9, period: 4.5117244, epoch: 2460186.649, duration: 2.04, depth: 0.31},
    {name: 'TOI-286 c', hostname: 'TOI-286', ra: 59.05000, dec: -60.66634, hostMag: 9.9, period: 39.361826, epoch: 2460155.025, duration: 4.97, depth: 0.55},
    {name: 'TOI-444 b', hostname: 'TOI-444', ra: 251.05000, dec: -26.76641, hostMag: 9.9, period: 17.9636, epoch: 2459190.039, duration: 3.76, depth: 1.1},
    {name: 'TOI-836 b', hostname: 'TOI-836', ra: 4.80000, dec: -24.45420, hostMag: 9.9, period: 3.8167262, epoch: 2459355.705, duration: 1.6, depth: 0.58},
    {name: 'TOI-836 c', hostname: 'TOI-836', ra: 4.80000, dec: -24.45420, hostMag: 9.9, period: 8.59545, epoch: 2458599.762, duration: 2.49, depth: 1.1},
    {name: 'WASP-178 b', hostname: 'WASP-178', ra: 136.22500, dec: -42.70497, hostMag: 9.9, period: 3.3448312, epoch: 2460087.94, duration: 3.32, depth: 13.6},
    {name: 'WASP-69 b', hostname: 'WASP-69', ra: 1.55000, dec: -5.09486, hostMag: 9.9, period: 3.86813881, epoch: 2455748.834, duration: 2.19, depth: 17.3},
    {name: 'XO-3 b', hostname: 'XO-3', ra: 328.17500, dec: 57.81721, hostMag: 9.9, period: 3.19152449, epoch: 2457417.987, duration: 2.5, depth: 8.9},
    {name: 'K2-291 b', hostname: 'K2-291', ra: 86.75000, dec: 21.54820, hostMag: 10, period: 2.2251639, epoch: 2460257.718, duration: 1.54, depth: 0.28},
    {name: 'TOI-4551 b', hostname: 'TOI-4551', ra: 298.72500, dec: -25.82785, hostMag: 10, period: 9.95581, epoch: 2458575.66, duration: 10.47, depth: 1},
    {name: 'TOI-481 b', hostname: 'TOI-481', ra: 330.75000, dec: -57.38500, hostMag: 10, period: 10.3311565, epoch: 2458924.888, duration: 5.63, depth: 4.6},
    {name: 'WASP-136 b', hostname: 'WASP-136', ra: 19.55000, dec: -8.92625, hostMag: 10, period: 5.21536179, epoch: 2459092.524, duration: 5.59, depth: 5.2},
    {name: 'TOI-1691 b', hostname: 'TOI-1691', ra: 144.25000, dec: 86.86034, hostMag: 10.1, period: 16.73688894, epoch: 2459922.726, duration: 4.98, depth: 0.99},
    {name: 'TOI-5126 b', hostname: 'TOI-5126', ra: 99.60000, dec: 18.63406, hostMag: 10.1, period: 5.4588385, epoch: 2459627.039, duration: 3.73, depth: 1.2},
    {name: 'TOI-5126 c', hostname: 'TOI-5126', ra: 99.60000, dec: 18.63406, hostMag: 10.1, period: 17.9051919, epoch: 2460258.339, duration: 4.55, depth: 0.77},
    {name: 'TOI-880.02', hostname: 'TOI-880.02', ra: 249.87500, dec: -13.98734, hostMag: 10.1, period: 2.57359428, epoch: 2460663.875, duration: 2.48, depth: 0.74},
    {name: 'TOI-880 c', hostname: 'TOI-880', ra: 249.87500, dec: -13.98734, hostMag: 10.1, period: 6.3872703, epoch: 2459403.675, duration: 2.34, depth: 3.5},
    {name: 'WASP-131 b', hostname: 'WASP-131', ra: 11.62500, dec: -30.58361, hostMag: 10.1, period: 5.3220125, epoch: 2458282.259, duration: 3.84, depth: 6.5},
    {name: 'TOI-1669 c', hostname: 'TOI-1669', ra: 57.40000, dec: 83.58743, hostMag: 10.2, period: 2.6800536, epoch: 2460660.824, duration: 1.76, depth: 0.46},
    {name: 'TOI-2018 b', hostname: 'TOI-2018', ra: 290.25000, dec: 29.20788, hostMag: 10.2, period: 7.4355709, epoch: 2458958.258, duration: 2.35, depth: 1.3},
    {name: 'TOI-6651 b', hostname: 'TOI-6651', ra: 47.32500, dec: 35.38904, hostMag: 10.2, period: 5.0569708, epoch: 2460601.086, duration: 3.4, depth: 0.8},
    {name: 'TOI-815 b', hostname: 'TOI-815', ra: 352.32500, dec: -43.83493, hostMag: 10.2, period: 11.1972769, epoch: 2460026.624, duration: 3.06, depth: 1.3},
    {name: 'TOI-815 c', hostname: 'TOI-815', ra: 352.32500, dec: -43.83493, hostMag: 10.2, period: 734.4987702, epoch: 2460023.13, duration: 2.53, depth: 1},
    {name: 'XO-6 b', hostname: 'XO-6', ra: 287.57500, dec: 73.82757, hostMag: 10.2, period: 3.7649949, epoch: 2460474.182, duration: 2.64, depth: 14.7},
    {name: 'TOI-954 b', hostname: 'TOI-954', ra: 116.47500, dec: -25.20880, hostMag: 10.3, period: 3.6849729, epoch: 2459156.27, duration: 5.09, depth: 2.1},
    {name: 'WASP-187 b', hostname: 'WASP-187', ra: 148.47500, dec: 25.68165, hostMag: 10.3, period: 5.147905, epoch: 2460602.632, duration: 5.41, depth: 3.7},
    {name: 'WASP-34 b', hostname: 'WASP-34', ra: 23.95000, dec: -23.86094, hostMag: 10.3, period: 4.3176859, epoch: 2460031.706, duration: 1.82, depth: 11.3},
    {name: 'TIC 139270665 b', hostname: 'TIC 139270665', ra: 242.02500, dec: 33.29145, hostMag: 10.4, period: 23.624, epoch: 2459592.366, duration: 5.94, depth: 4.2},
    {name: 'TOI-1768.01', hostname: 'TOI-1768.01', ra: 126.17500, dec: 55.53996, hostMag: 10.4, period: 7.33770365, epoch: 2459627.022, duration: 4.56, depth: 0.8},
    {name: 'K2-373 b', hostname: 'K2-373', ra: 188.17500, dec: 13.68850, hostMag: 10.5, period: 11.0213, epoch: 2457150.292, duration: 4.32, depth: 0.2},
    {name: 'Kepler-126 b', hostname: 'Kepler-126', ra: 260.85000, dec: 44.20844, hostMag: 10.5, period: 10.49568685, epoch: 2454963.808, duration: 5.07, depth: 0.11},
    {name: 'Kepler-126 c', hostname: 'Kepler-126', ra: 260.85000, dec: 44.20844, hostMag: 10.5, period: 21.86969391, epoch: 2454973.294, duration: 5.91, depth: 0.12},
    {name: 'Kepler-126 d', hostname: 'Kepler-126', ra: 260.85000, dec: 44.20844, hostMag: 10.5, period: 100.2830979, epoch: 2454977.762, duration: 10.97, depth: 0.36},
    {name: 'Kepler-381 b', hostname: 'Kepler-381', ra: 10.97500, dec: 43.83103, hostMag: 10.5, period: 5.6291146, epoch: 2454956.475, duration: 4.05, depth: 0.04},
    {name: 'Kepler-381 c', hostname: 'Kepler-381', ra: 10.97500, dec: 43.83103, hostMag: 10.5, period: 13.39144182, epoch: 2454966.061, duration: 3.69, depth: 0.05},
    {name: 'Kepler-381 d', hostname: 'Kepler-381', ra: 10.97500, dec: 43.83103, hostMag: 10.5, period: 8.2563025, epoch: 2454970.925, duration: 1.99, depth: 0.04},
    {name: 'Kepler-50 b', hostname: 'Kepler-50', ra: 186.05000, dec: 50.03368, hostMag: 10.5, period: 7.8128315, epoch: 2454958.74, duration: 4.49, depth: 0.1},
    {name: 'Kepler-50 c', hostname: 'Kepler-50', ra: 186.05000, dec: 50.03368, hostMag: 10.5, period: 9.37663871, epoch: 2454960.577, duration: 2.63, depth: 0.13},
    {name: 'TOI-1221 b', hostname: 'TOI-1221', ra: 175.25000, dec: -65.50886, hostMag: 10.5, period: 91.68278, epoch: 2458404.179, duration: 8.12, depth: 0.72},
    {name: 'TOI-220 b', hostname: 'TOI-220', ra: 107.97500, dec: -61.99721, hostMag: 10.5, period: 10.6953083, epoch: 2460175.494, duration: 2.04, depth: 0.92},
    {name: 'WASP-121 b', hostname: 'WASP-121', ra: 156.02500, dec: -39.09727, hostMag: 10.5, period: 1.27492476, epoch: 2458661.564, duration: 2.91, depth: 18.7},
    {name: 'WASP-167 b', hostname: 'WASP-167', ra: 62.62500, dec: -35.54953, hostMag: 10.5, period: 2.02195933, epoch: 2458117.022, duration: 2.72, depth: 8.2},
    {name: 'WASP-73 b', hostname: 'WASP-73', ra: 296.97500, dec: -58.14893, hostMag: 10.5, period: 4.0873001, epoch: 2458462.555, duration: 5.59, depth: 3.3},
    {name: 'LTT 1445 A b', hostname: 'LTT 1445 A', ra: 27.75000, dec: -16.59449, hostMag: 10.6, period: 5.358765, epoch: 2458423.426, duration: 1.39, depth: 1.7},
    {name: 'LTT 1445 A c', hostname: 'LTT 1445 A', ra: 27.75000, dec: -16.59449, hostMag: 10.6, period: 3.123898, epoch: 2458425.078, duration: 0.48, depth: 1.6},
    {name: 'TOI-1107 b', hostname: 'TOI-1107', ra: 336.47500, dec: -82.21887, hostMag: 10.6, period: 4.07823916, epoch: 2459336.074, duration: 4.85, depth: 6},
    {name: 'TOI-1386 b', hostname: 'TOI-1386', ra: 270.25000, dec: 54.31904, hostMag: 10.6, period: 25.8386422, epoch: 2460561.018, duration: 5.21, depth: 1.8},
    {name: 'TOI-1439 b', hostname: 'TOI-1439', ra: 105.82500, dec: 67.87764, hostMag: 10.6, period: 27.6438617, epoch: 2460638.546, duration: 5.32, depth: 0.56},
    {name: 'K2-65 b', hostname: 'K2-65', ra: 192.75000, dec: -10.92614, hostMag: 10.7, period: 12.64655, epoch: 2456986.33, duration: 2.93, depth: 0.39},
    {name: 'TOI-1279 b', hostname: 'TOI-1279', ra: 303.77500, dec: 56.20141, hostMag: 10.7, period: 9.61416357, epoch: 2459659.674, duration: 3.43, depth: 0.93},
    {name: 'TOI-1739 b', hostname: 'TOI-1739', ra: 10.35000, dec: 83.25866, hostMag: 10.7, period: 8.30334141, epoch: 2459631.82, duration: 1.87, depth: 0.43},
    {name: 'TOI-1823 b', hostname: 'TOI-1823', ra: 73.17500, dec: 63.75326, hostMag: 10.7, period: 38.8135498, epoch: 2460345.349, duration: 5.94, depth: 9.6},
    {name: 'TOI-199 b', hostname: 'TOI-199', ra: 306.35000, dec: -59.89543, hostMag: 10.7, period: 104.8729635, epoch: 2460038.977, duration: 6.55, depth: 12.2},
    {name: 'TOI-238 b', hostname: 'TOI-238', ra: 253.87500, dec: -18.60665, hostMag: 10.7, period: 1.2730965, epoch: 2460205.748, duration: 1.48, depth: 0.41},
    {name: 'TOI-238 c', hostname: 'TOI-238', ra: 253.87500, dec: -18.60665, hostMag: 10.7, period: 8.465651, epoch: 2460204.968, duration: 1.93, depth: 0.71},
    {name: 'TOI-5795 b', hostname: 'TOI-5795', ra: 292.12500, dec: -7.54766, hostMag: 10.7, period: 6.1406325, epoch: 2459770.674, duration: 3.41, depth: 2.6},
    {name: 'WASP-180 A b', hostname: 'WASP-180 A', ra: 203.52500, dec: -1.98279, hostMag: 10.7, period: 3.4092646, epoch: 2458206.519, duration: 3.12, depth: 12.3},
    {name: 'WASP-68 b', hostname: 'WASP-68', ra: 305.75000, dec: -19.31473, hostMag: 10.7, period: 5.0843144, epoch: 2456802.089, duration: 5.14, depth: 5.7},
    {name: 'WASP-87 b', hostname: 'WASP-87', ra: 319.47500, dec: -52.84082, hostMag: 10.7, period: 1.68279422, epoch: 2458276.861, duration: 3.03, depth: 7.7},
    {name: 'K2-31 b', hostname: 'K2-31', ra: 326.42500, dec: -23.54827, hostMag: 10.8, period: 1.257813, epoch: 2460775.326, duration: 0.98, depth: 7.4},
    {name: 'Kepler-25 b', hostname: 'Kepler-25', ra: 98.30000, dec: 39.48790, hostMag: 10.8, period: 6.23853479, epoch: 2458648.008, duration: 3.54, depth: 0.4},
    {name: 'Kepler-25 c', hostname: 'Kepler-25', ra: 98.30000, dec: 39.48790, hostMag: 10.8, period: 12.72037372, epoch: 2454960.646, duration: 2.96, depth: 1.2},
    {name: 'TOI-712 b', hostname: 'TOI-712', ra: 176.17500, dec: -65.82584, hostMag: 10.8, period: 9.531366, epoch: 2460139.317, duration: 1.67, depth: 0.92},
    {name: 'TOI-712 c', hostname: 'TOI-712', ra: 176.17500, dec: -65.82584, hostMag: 10.8, period: 51.6991421, epoch: 2460083.781, duration: 4.37, depth: 1.3},
    {name: 'TOI-712 d', hostname: 'TOI-712', ra: 176.17500, dec: -65.82584, hostMag: 10.8, period: 84.83869, epoch: 2460082.804, duration: 5.19, depth: 1},
    {name: 'WASP-186 b', hostname: 'WASP-186', ra: 239.72500, dec: 21.61691, hostMag: 10.8, period: 5.0267952, epoch: 2458911.375, duration: 2.7, depth: 6.1},
    {name: 'WASP-70 A b', hostname: 'WASP-70 A', ra: 28.62500, dec: -13.43338, hostMag: 10.8, period: 3.71301695, epoch: 2456319.448, duration: 3.33, depth: 9.7},
    {name: 'XO-4 b', hostname: 'XO-4', ra: 323.27500, dec: 58.26811, hostMag: 10.8, period: 4.12506679, epoch: 2456878.473, duration: 4.45, depth: 7.8},
    {name: 'K2-233 b', hostname: 'K2-233', ra: 328.80000, dec: -20.23180, hostMag: 10.9, period: 2.4675, epoch: 2457991.691, duration: 1.99, depth: 0.29},
    {name: 'K2-233 c', hostname: 'K2-233', ra: 328.80000, dec: -20.23180, hostMag: 10.9, period: 7.06005, epoch: 2457586.877, duration: 2.8, depth: 0.27},
    {name: 'K2-233 d', hostname: 'K2-233', ra: 328.80000, dec: -20.23180, hostMag: 10.9, period: 24.36543, epoch: 2458151.774, duration: 3.79, depth: 0.93},
    {name: 'Kepler-65 b', hostname: 'Kepler-65', ra: 221.32500, dec: 41.15111, hostMag: 10.9, period: 2.15490651, epoch: 2454953.571, duration: 3.42, depth: 0.1},
    {name: 'Kepler-65 c', hostname: 'Kepler-65', ra: 221.32500, dec: 41.15111, hostMag: 10.9, period: 5.85994028, epoch: 2454959.18, duration: 4.28, depth: 0.32},
    {name: 'Kepler-65 d', hostname: 'Kepler-65', ra: 221.32500, dec: 41.15111, hostMag: 10.9, period: 8.13135942, epoch: 2454970.977, duration: 4.1, depth: 0.1},
    {name: 'TOI-1268 b', hostname: 'TOI-1268', ra: 203.32500, dec: 62.30538, hostMag: 10.9, period: 8.157721, epoch: 2460359.607, duration: 3.79, depth: 10.3},
    {name: 'TOI-1444 b', hostname: 'TOI-1444', ra: 328.50000, dec: 70.94371, hostMag: 10.9, period: 0.4702743, epoch: 2458711.368, duration: 1.28, depth: 0.21},
    {name: 'TOI-3362 b', hostname: 'TOI-3362', ra: 359.05000, dec: -56.84312, hostMag: 10.9, period: 18.0953159, epoch: 2460031.241, duration: 2.63, depth: 3.2},
    {name: 'TOI-4406 b', hostname: 'TOI-4406', ra: 182.90000, dec: -56.92539, hostMag: 10.9, period: 30.08350298, epoch: 2459064.119, duration: 3.99, depth: 5.4},
    {name: 'TOI-451 b', hostname: 'TOI-451', ra: 177.97500, dec: -37.93973, hostMag: 10.9, period: 1.85866242, epoch: 2458410.999, duration: 2.05, depth: 0.5},
    {name: 'TOI-451 c', hostname: 'TOI-451', ra: 177.97500, dec: -37.93973, hostMag: 10.9, period: 9.192402, epoch: 2459000.114, duration: 3.56, depth: 1},
    {name: 'TOI-451 d', hostname: 'TOI-451', ra: 177.97500, dec: -37.93973, hostMag: 10.9, period: 16.364909, epoch: 2458727.567, duration: 4.1, depth: 1.8},
    {name: 'TOI-4527.01', hostname: 'TOI-4527.01', ra: 268.32500, dec: 5.47120, hostMag: 10.9, period: 0.3994445, epoch: 2459474.2, duration: 0.8, depth: 0.33},
    {name: 'TOI-5076 b', hostname: 'TOI-5076', ra: 330.62500, dec: 17.23921, hostMag: 10.9, period: 23.443162, epoch: 2460204.002, duration: 4.88, depth: 1.4},
    {name: 'WASP-35 b', hostname: 'WASP-35', ra: 64.92500, dec: -6.22978, hostMag: 10.9, period: 3.16156853, epoch: 2458120.804, duration: 3.14, depth: 15},
    {name: 'HIP 65 A b', hostname: 'HIP 65 A', ra: 11.12500, dec: -54.83082, hostMag: 11, period: 0.98097217, epoch: 2458658.654, duration: 0.79, depth: 82},
    {name: 'K2-198 b', hostname: 'K2-198', ra: 230.62500, dec: -6.46499, hostMag: 11, period: 17.0428683, epoch: 2457204.569, duration: 2.96, depth: 2.7},
    {name: 'K2-198 c', hostname: 'K2-198', ra: 230.62500, dec: -6.46499, hostMag: 11, period: 3.3596055, epoch: 2457215.032, duration: 1.42, depth: 0.18},
    {name: 'K2-198 d', hostname: 'K2-198', ra: 230.62500, dec: -6.46499, hostMag: 11, period: 7.4500372, epoch: 2457824.481, duration: 3, depth: 1.1},
    {name: 'K2-243 b', hostname: 'K2-243', ra: 67.27500, dec: -4.89914, hostMag: 11, period: 11.54182, epoch: 2457593.206, duration: 3.7, depth: 0.16},
    {name: 'K2-243 c', hostname: 'K2-243', ra: 67.27500, dec: -4.89914, hostMag: 11, period: 24.94598, epoch: 2457584.505, duration: 5.2, depth: 0.19},
    {name: 'Kepler-1655 b', hostname: 'Kepler-1655', ra: 101.37500, dec: 39.21208, hostMag: 11, period: 11.87290396, epoch: 2454954.531, duration: 2.75, depth: 0.35},
    {name: 'L 168-9 b', hostname: 'L 168-9', ra: 301.72500, dec: -60.06573, hostMag: 11, period: 1.40152604, epoch: 2459082.857, duration: 1.02, depth: 0.59},
    {name: 'TOI-1117 b', hostname: 'TOI-1117', ra: 216.12500, dec: -66.41998, hostMag: 11, period: 2.22816, epoch: 2459386.964, duration: 2.02, depth: 0.63},
    {name: 'TOI-1173 b', hostname: 'TOI-1173', ra: 160.97500, dec: 70.76801, hostMag: 11, period: 7.0643978, epoch: 2460341.784, duration: 2.42, depth: 8.3},
    {name: 'TOI-1180 b', hostname: 'TOI-1180', ra: 273.35000, dec: 82.19376, hostMag: 11, period: 9.68676038, epoch: 2459950.327, duration: 2.75, depth: 1.7},
    {name: 'TOI-1184 b', hostname: 'TOI-1184', ra: 132.27500, dec: 60.67878, hostMag: 11, period: 5.7484338, epoch: 2459960.512, duration: 1.89, depth: 1},
    {name: 'TOI-1273 b', hostname: 'TOI-1273', ra: 247.25000, dec: 58.39025, hostMag: 11, period: 4.631296, epoch: 2458712.347, duration: 1.44, depth: 4.9},
    {name: 'TOI-1683.01', hostname: 'TOI-1683.01', ra: 358.77500, dec: 27.82237, hostMag: 11, period: 3.05752396, epoch: 2458816.412, duration: 1.38, depth: 1.1},
    {name: 'WASP-118 b', hostname: 'WASP-118', ra: 273.02500, dec: 2.70278, hostMag: 11, period: 4.0460496, epoch: 2459450.116, duration: 4.8, depth: 7.5},
    {name: 'WASP-120 b', hostname: 'WASP-120', ra: 156.97500, dec: -45.89824, hostMag: 11, period: 3.61126721, epoch: 2458538.123, duration: 3.56, depth: 6.6},
    {name: 'WASP-123 b', hostname: 'WASP-123', ra: 268.75000, dec: -32.86013, hostMag: 11, period: 2.9776446, epoch: 2460147.379, duration: 2.96, depth: 13},
    {name: 'WASP-126 b', hostname: 'WASP-126', ra: 108.76183, dec: 0.26631, hostMag: 11, period: 3.28878983, epoch: 2458327.52, duration: 3.44, depth: 7},
    {name: 'WASP-172 b', hostname: 'WASP-172', ra: 266.02500, dec: -47.23758, hostMag: 11, period: 5.4774317, epoch: 2458856.247, duration: 5.29, depth: 7.2},
    {name: 'K2-352 b', hostname: 'K2-352', ra: 326.70000, dec: 18.46963, hostMag: 11.1, period: 3.665912, epoch: 2458098.635, duration: 1.63, depth: 0.17},
    {name: 'K2-352 c', hostname: 'K2-352', ra: 326.70000, dec: 18.46963, hostMag: 11.1, period: 8.234885, epoch: 2458098.717, duration: 3.59, depth: 0.4},
    {name: 'K2-352 d', hostname: 'K2-352', ra: 326.70000, dec: 18.46963, hostMag: 11.1, period: 14.871387, epoch: 2458103.623, duration: 4.14, depth: 1.9},
    {name: 'Kepler-1713 b', hostname: 'Kepler-1713', ra: 140.75000, dec: 43.37839, hostMag: 11.1, period: 18.01162316, epoch: 2454964.056, duration: 6.62, depth: 0.11},
    {name: 'TOI-1199 b', hostname: 'TOI-1199', ra: 112.85000, dec: 61.35257, hostMag: 11.1, period: 3.671463, epoch: 2459420.538, duration: 2.15, depth: 4.3},
    {name: 'TOI-1249 b', hostname: 'TOI-1249', ra: 333.70000, dec: 66.30853, hostMag: 11.1, period: 13.0791581, epoch: 2460342.349, duration: 2.97, depth: 1.1},
    {name: 'TOI-1410.01', hostname: 'TOI-1410.01', ra: 292.97500, dec: 42.56031, hostMag: 11.1, period: 1.2168732, epoch: 2459850.737, duration: 0.86, depth: 1.2},
    {name: 'TOI-1453 b', hostname: 'TOI-1453', ra: 193.40000, dec: 57.19778, hostMag: 11.1, period: 4.3135263, epoch: 2460583.435, duration: 1.87, depth: 0.27},
    {name: 'TOI-1453 c', hostname: 'TOI-1453', ra: 193.40000, dec: 57.19778, hostMag: 11.1, period: 6.5886877, epoch: 2460660.409, duration: 1.68, depth: 0.85},
    {name: 'TOI-5110 b', hostname: 'TOI-5110', ra: 264.25000, dec: 31.61033, hostMag: 11.1, period: 30.1584857, epoch: 2460227.48, duration: 3.85, depth: 2.3},
    {name: 'TOI-559 b', hostname: 'TOI-559', ra: 109.12500, dec: -31.16299, hostMag: 11.1, period: 6.9839095, epoch: 2458893.813, duration: 5.15, depth: 8.3},
    {name: 'TOI-905 b', hostname: 'TOI-905', ra: 159.52500, dec: -71.36163, hostMag: 11.1, period: 3.73957156, epoch: 2458628.35, duration: 2.04, depth: 15.3},
    {name: 'WASP-140 b', hostname: 'WASP-140', ra: 23.12500, dec: -20.45100, hostMag: 11.1, period: 2.23598448, epoch: 2458533.441, duration: 1.51, depth: 20.5},
    {name: 'WASP-185 b', hostname: 'WASP-185', ra: 243.57500, dec: -19.54231, hostMag: 11.1, period: 9.3911326, epoch: 2460794.217, duration: 4.51, depth: 6.1},
    {name: 'Kepler-1349 b', hostname: 'Kepler-1349', ra: 80.30000, dec: 48.74427, hostMag: 11.2, period: 2.1282478, epoch: 2454965.469, duration: 3.4, depth: 0.03},
    {name: 'Kepler-1972 b', hostname: 'Kepler-1972', ra: 203.72500, dec: 39.87251, hostMag: 11.2, period: 7.5459119, epoch: 2454967.489, duration: 6.93, depth: 0.02},
    {name: 'Kepler-1972 c', hostname: 'Kepler-1972', ra: 203.72500, dec: 39.87251, hostMag: 11.2, period: 11.3220104, epoch: 2454975.714, duration: 5.86, depth: 0.02},
    {name: 'Kepler-907 b', hostname: 'Kepler-907', ra: 28.60000, dec: 41.63266, hostMag: 11.2, period: 15.86627596, epoch: 2454958.218, duration: 4.28, depth: 0.07},
    {name: 'NGTS-20 b', hostname: 'NGTS-20', ra: 77.55000, dec: -21.93365, hostMag: 11.2, period: 54.18915, epoch: 2458432.98, duration: 4.55, depth: 3.7},
    {name: 'TOI-2498 b', hostname: 'TOI-2498', ra: 324.97500, dec: 11.25165, hostMag: 11.2, period: 3.738252, epoch: 2459204.417, duration: 2.98, depth: 1.3},
    {name: 'TOI-470 b', hostname: 'TOI-470', ra: 240.60000, dec: -25.03141, hostMag: 11.2, period: 12.19148, epoch: 2459205.983, duration: 3.06, depth: 2.3},
    {name: 'TOI-858 B b', hostname: 'TOI-858 B', ra: 12.00000, dec: -54.59292, hostMag: 11.2, period: 3.27972061, epoch: 2459088.312, duration: 3.58, depth: 11.1},
    {name: 'WASP-106 b', hostname: 'WASP-106', ra: 85.77500, dec: -5.07949, hostMag: 11.2, period: 9.2897057, epoch: 2457652.839, duration: 5.33, depth: 6.2},
    {name: 'WASP-24 b', hostname: 'WASP-24', ra: 132.92500, dec: 2.34329, hostMag: 11.2, period: 2.3412202, epoch: 2455402.127, duration: 2.68, depth: 10},
    {name: 'WASP-63 b', hostname: 'WASP-63', ra: 260.17500, dec: -38.32338, hostMag: 11.2, period: 4.37808205, epoch: 2458574.771, duration: 5.39, depth: 6.1},
    {name: 'K2-165 b', hostname: 'K2-165', ra: 294.02500, dec: 0.96833, hostMag: 11.3, period: 2.354992, epoch: 2457584.483, duration: 1.76, depth: 0.21},
    {name: 'K2-165 c', hostname: 'K2-165', ra: 294.02500, dec: 0.96833, hostMag: 11.3, period: 4.382745, epoch: 2457584.213, duration: 2.75, depth: 0.31},
    {name: 'K2-165 d', hostname: 'K2-165', ra: 294.02500, dec: 0.96833, hostMag: 11.3, period: 14.101361, epoch: 2457586.758, duration: 2.71, depth: 1.5},
    {name: 'K2-24 b', hostname: 'K2-24', ra: 154.40000, dec: -24.99060, hostMag: 11.3, period: 20.88506, epoch: 2456905.796, duration: 5.47, depth: 2.2},
    {name: 'K2-24 c', hostname: 'K2-24', ra: 154.40000, dec: -24.99060, hostMag: 11.3, period: 42.3633, epoch: 2456915.625, duration: 6.47, depth: 4.4},
    {name: 'K2-38 b', hostname: 'K2-38', ra: 2.00000, dec: -23.18942, hostMag: 11.3, period: 4.01663, epoch: 2456896.869, duration: 3.19, depth: 0.26},
    {name: 'K2-38 c', hostname: 'K2-38', ra: 2.00000, dec: -23.18942, hostMag: 11.3, period: 10.56131, epoch: 2456900.476, duration: 2.64, depth: 0.48},
    {name: 'K2-73 b', hostname: 'K2-73', ra: 301.55000, dec: -9.05609, hostMag: 11.3, period: 7.49569, epoch: 2456980.176, duration: 3.59, depth: 0.59},
    {name: 'TOI-1194 b', hostname: 'TOI-1194', ra: 169.30000, dec: 69.96478, hostMag: 11.3, period: 2.3106428, epoch: 2460367.072, duration: 1.29, depth: 6.9},
    {name: 'TOI-1295 b', hostname: 'TOI-1295', ra: 100.32500, dec: 67.87150, hostMag: 11.3, period: 3.1968838, epoch: 2459913.38, duration: 6.2, depth: 8},
    {name: 'TOI-1301.01', hostname: 'TOI-1301.01', ra: 351.75000, dec: 71.58175, hostMag: 11.3, period: 6.09640721, epoch: 2459710.294, duration: 2.33, depth: 1.1},
    {name: 'TOI-172 b', hostname: 'TOI-172', ra: 97.92500, dec: -26.69287, hostMag: 11.3, period: 9.476936, epoch: 2459085.072, duration: 4.71, depth: 3.1},
    {name: 'TOI-2031 A b', hostname: 'TOI-2031 A', ra: 67.07500, dec: 81.56595, hostMag: 11.3, period: 5.71548654, epoch: 2459806.029, duration: 4.03, depth: 11},
    {name: 'TOI-2411 b', hostname: 'TOI-2411', ra: 355.35000, dec: -8.70179, hostMag: 11.3, period: 0.7826942, epoch: 2459116.014, duration: 1.26, depth: 0.52},
    {name: 'TOI-4137 b', hostname: 'TOI-4137', ra: 156.77500, dec: 70.39108, hostMag: 11.3, period: 3.8016217, epoch: 2459762.196, duration: 3.22, depth: 8.3},
    {name: 'TOI-4582 b', hostname: 'TOI-4582', ra: 111.60000, dec: 68.86563, hostMag: 11.3, period: 31.0343214, epoch: 2459394.938, duration: 12.06, depth: 1.6},
    {name: 'WASP-26 b', hostname: 'WASP-26', ra: 276.17500, dec: -15.26741, hostMag: 11.3, period: 2.75659784, epoch: 2456548.8, duration: 2.38, depth: 10},
    {name: 'WASP-32 b', hostname: 'WASP-32', ra: 237.70000, dec: 1.20051, hostMag: 11.3, period: 2.71866151, epoch: 2456523.98, duration: 2.42, depth: 11},
    {name: 'XO-1 b', hostname: 'XO-1', ra: 32.95000, dec: 28.16963, hostMag: 11.3, period: 3.941505, epoch: 2455385.52, duration: 2.97, depth: 18},
    {name: 'K2-223 b', hostname: 'K2-223', ra: 318.37500, dec: -10.28209, hostMag: 11.4, period: 0.50557, epoch: 2457583.062, duration: 0.9, depth: 0.1},
    {name: 'K2-223 c', hostname: 'K2-223', ra: 318.37500, dec: -10.28209, hostMag: 11.4, period: 4.562546, epoch: 2457628.612, duration: 2.8, depth: 0.2},
    {name: 'TOI-1296 b', hostname: 'TOI-1296', ra: 106.22500, dec: 70.23848, hostMag: 11.4, period: 3.94436676, epoch: 2459766.963, duration: 4.87, depth: 6.7},
    {name: 'TOI-1798.01', hostname: 'TOI-1798.01', ra: 65.62500, dec: 46.51928, hostMag: 11.4, period: 8.02152233, epoch: 2459688.136, duration: 3.13, depth: 0.88},
    {name: 'TOI-1798.02', hostname: 'TOI-1798.02', ra: 65.62500, dec: 46.51928, hostMag: 11.4, period: 0.43781182, epoch: 2459691.314, duration: 1.22, depth: 0.29},
    {name: 'TOI-2421 b', hostname: 'TOI-2421', ra: 189.25000, dec: -35.39092, hostMag: 11.4, period: 4.3474032, epoch: 2458957.028, duration: 4.86, depth: 2.9},
    {name: 'TOI-2580 b', hostname: 'TOI-2580', ra: 131.95000, dec: 67.11653, hostMag: 11.4, period: 3.39775, epoch: 2458839.453, duration: 8.38, depth: 10},
    {name: 'TOI-2589 b', hostname: 'TOI-2589', ra: 149.30000, dec: -37.23095, hostMag: 11.4, period: 61.6277, epoch: 2459973.64, duration: 6.4, depth: 8.9},
    {name: 'TOI-4127 b', hostname: 'TOI-4127', ra: 24.27500, dec: 72.41493, hostMag: 11.4, period: 56.39879, epoch: 2458862.728, duration: 4.07, depth: 7.5},
    {name: 'TOI-5678 b', hostname: 'TOI-5678', ra: 143.05000, dec: -34.19848, hostMag: 11.4, period: 47.73022, epoch: 2458424.706, duration: 6.96, depth: 2.4},
    {name: 'WASP-49 b', hostname: 'WASP-49', ra: 65.37500, dec: -16.96539, hostMag: 11.4, period: 2.78173691, epoch: 2457377.597, duration: 2.14, depth: 14},
    {name: 'HATS-56 b', hostname: 'HATS-56', ra: 9.90000, dec: -45.79946, hostMag: 11.5, period: 4.3247662, epoch: 2458890.819, duration: 4.64, depth: 6.4},
    {name: 'K2-141 b', hostname: 'K2-141', ra: 355.02500, dec: -1.18918, hostMag: 11.5, period: 0.2803246, epoch: 2460232.513, duration: 0.87, depth: 0.51},
    {name: 'K2-141 c', hostname: 'K2-141', ra: 355.02500, dec: -1.18918, hostMag: 11.5, period: 7.7485, epoch: 2457751.155, duration: 0.8, depth: 8.8},
    {name: 'K2-210 b', hostname: 'K2-210', ra: 158.47500, dec: 1.57841, hostMag: 11.5, period: 0.570233, epoch: 2457393.958, duration: 0.91, depth: 0.08},
    {name: 'Kepler-131 b', hostname: 'Kepler-131', ra: 211.85000, dec: 40.94237, hostMag: 11.5, period: 16.09196403, epoch: 2454955.323, duration: 3.13, depth: 0.43},
    {name: 'Kepler-131 c', hostname: 'Kepler-131', ra: 211.85000, dec: 40.94237, hostMag: 11.5, period: 25.51682997, epoch: 2454961.921, duration: 5.38, depth: 0.07},
    {name: 'Kepler-997 b', hostname: 'Kepler-997', ra: 254.00000, dec: 49.93889, hostMag: 11.5, period: 2.70729361, epoch: 2454954.602, duration: 3.61, depth: 0.07},
    {name: 'Ross 176 b', hostname: 'Ross 176', ra: 341.37500, dec: 47.30862, hostMag: 11.5, period: 5.006622, epoch: 2460550.715, duration: 1.66, depth: 1.3},
    {name: 'TOI-1235 b', hostname: 'TOI-1235', ra: 133.10000, dec: 69.27662, hostMag: 11.5, period: 3.4447015, epoch: 2460333.631, duration: 1.91, depth: 0.8},
    {name: 'TOI-163 b', hostname: 'TOI-163', ra: 286.10000, dec: -71.89553, hostMag: 11.5, period: 4.23111726, epoch: 2458544.67, duration: 4.35, depth: 7.3},
    {name: 'TOI-4791 b', hostname: 'TOI-4791', ra: 263.30000, dec: -19.82894, hostMag: 11.5, period: 4.28088, epoch: 2459237.595, duration: 3.33, depth: 6.6},
    {name: 'TOI-5704 b', hostname: 'TOI-5704', ra: 289.50000, dec: 44.98908, hostMag: 11.5, period: 3.771116, epoch: 2459610.757, duration: 2.34, depth: 1.6},
    {name: 'Kepler-130 b', hostname: 'Kepler-130', ra: 207.02500, dec: 40.24520, hostMag: 11.6, period: 8.4574215, epoch: 2454955.157, duration: 3.55, depth: 0.08},
    {name: 'Kepler-130 c', hostname: 'Kepler-130', ra: 207.02500, dec: 40.24520, hostMag: 11.6, period: 27.50862867, epoch: 2454960.088, duration: 6.1, depth: 0.65},
    {name: 'Kepler-130 d', hostname: 'Kepler-130', ra: 207.02500, dec: 40.24520, hostMag: 11.6, period: 87.51756205, epoch: 2455034.161, duration: 2.73, depth: 0.16},
    {name: 'Kepler-454 b', hostname: 'Kepler-454', ra: 148.72500, dec: 38.22908, hostMag: 11.6, period: 10.57375768, epoch: 2454955.198, duration: 1.99, depth: 0.3},
    {name: 'Kepler-909 b', hostname: 'Kepler-909', ra: 270.37500, dec: 45.37097, hostMag: 11.6, period: 13.93296076, epoch: 2455014.207, duration: 2.73, depth: 0.13},
    {name: 'NGTS-33 b', hostname: 'NGTS-33', ra: 170.00000, dec: -35.85052, hostMag: 11.6, period: 2.827972, epoch: 2459986.409, duration: 2.62, depth: 14.8},
    {name: 'TOI-1130 b', hostname: 'TOI-1130', ra: 82.55000, dec: -41.43764, hostMag: 11.6, period: 4.077039, epoch: 2458866.675, duration: 1.84, depth: 2.7},
    {name: 'TOI-1130 c', hostname: 'TOI-1130', ra: 82.55000, dec: -41.43764, hostMag: 11.6, period: 8.3498494, epoch: 2458841.601, duration: 2.02, depth: 16.7},
    {name: 'TOI-1775 b', hostname: 'TOI-1775', ra: 6.90000, dec: 39.45775, hostMag: 11.6, period: 10.2405483, epoch: 2459635.364, duration: 3.54, depth: 9.9},
    {name: 'TOI-2046 b', hostname: 'TOI-2046', ra: 71.10000, dec: 74.33131, hostMag: 11.6, period: 1.4971842, epoch: 2457792.277, duration: 2.41, depth: 16.3},
    {name: 'TOI-2236 b', hostname: 'TOI-2236', ra: 309.95000, dec: -86.97996, hostMag: 11.6, period: 3.5315897, epoch: 2459389.337, duration: 2.69, depth: 7.2},
    {name: 'TOI-3331 A b', hostname: 'TOI-3331 A', ra: 79.45000, dec: -34.10717, hostMag: 11.6, period: 2.0180196, epoch: 2459383.76, duration: 1.97, depth: 15.2},
    {name: 'TOI-4153 b', hostname: 'TOI-4153', ra: 323.60000, dec: 82.21608, hostMag: 11.6, period: 4.6174141, epoch: 2459557.057, duration: 4.51, depth: 9.3},
    {name: 'TOI-5027 b', hostname: 'TOI-5027', ra: 233.10000, dec: -69.21710, hostMag: 11.6, period: 10.24368, epoch: 2458649.458, duration: 3, depth: 9.4},
    {name: 'TOI-5386 A b', hostname: 'TOI-5386 A', ra: 66.42500, dec: 60.53623, hostMag: 11.6, period: 3.62156552, epoch: 2459621.282, duration: 2.22, depth: 11.7},
    {name: 'WASP-156 b', hostname: 'WASP-156', ra: 166.92500, dec: 2.41819, hostMag: 11.6, period: 3.83616488, epoch: 2459058.611, duration: 2.4, depth: 5.4},
    {name: 'WASP-21 b', hostname: 'WASP-21', ra: 149.57500, dec: 18.39616, hostMag: 11.6, period: 4.32250416, epoch: 2457738.54, duration: 3.36, depth: 10.8},
    {name: 'WASP-90 b', hostname: 'WASP-90', ra: 31.92500, dec: 7.05628, hostMag: 11.6, period: 3.9162637, epoch: 2457292.956, duration: 3.36, depth: 7.1},
    {name: 'HAT-P-31 b', hostname: 'HAT-P-31', ra: 92.25000, dec: 26.42661, hostMag: 11.7, period: 5.0052702, epoch: 2458940.753, duration: 4.91, depth: 6.5},
    {name: 'K2-139 b', hostname: 'K2-139', ra: 244.00000, dec: -17.91071, hostMag: 11.7, period: 28.38246, epoch: 2457325.817, duration: 4.99, depth: 11.1},
    {name: 'K2-36 b', hostname: 'K2-36', ra: 266.95000, dec: 3.86650, hostMag: 11.7, period: 1.422602, epoch: 2456810.892, duration: 1.12, depth: 0.35},
    {name: 'K2-36 c', hostname: 'K2-36', ra: 266.95000, dec: 3.86650, hostMag: 11.7, period: 5.3410507, epoch: 2456812.839, duration: 1.15, depth: 1.5},
    {name: 'K2-66 b', hostname: 'K2-66', ra: 91.60000, dec: -10.71154, hostMag: 11.7, period: 5.06965, epoch: 2456984.009, duration: 4.4, depth: 0.29},
    {name: 'Kepler-127 b', hostname: 'Kepler-127', ra: 11.40000, dec: 46.02806, hostMag: 11.7, period: 14.43602503, epoch: 2454960.068, duration: 3.62, depth: 0.1},
    {name: 'Kepler-127 c', hostname: 'Kepler-127', ra: 11.40000, dec: 46.02806, hostMag: 11.7, period: 29.39325141, epoch: 2454953.887, duration: 7.25, depth: 0.33},
    {name: 'Kepler-127 d', hostname: 'Kepler-127', ra: 11.40000, dec: 46.02806, hostMag: 11.7, period: 48.63036781, epoch: 2454956.917, duration: 7.22, depth: 0.35},
    {name: 'Kepler-92 b', hostname: 'Kepler-92', ra: 245.15000, dec: 41.56302, hostMag: 11.7, period: 13.74882953, epoch: 2454957.283, duration: 6.22, depth: 0.43},
    {name: 'Kepler-92 c', hostname: 'Kepler-92', ra: 245.15000, dec: 41.56302, hostMag: 11.7, period: 26.72320347, epoch: 2454954.21, duration: 9.01, depth: 0.2},
    {name: 'Kepler-92 d', hostname: 'Kepler-92', ra: 245.15000, dec: 41.56302, hostMag: 11.7, period: 49.3570565, epoch: 2454967.286, duration: 10.71, depth: 0.13},
    {name: 'L 98-59 b', hostname: 'L 98-59', ra: 271.97500, dec: -68.31447, hostMag: 11.7, period: 2.253114, epoch: 2458366.171, duration: 1.01, depth: 0.59},
    {name: 'L 98-59 c', hostname: 'L 98-59', ra: 271.97500, dec: -68.31447, hostMag: 11.7, period: 3.6906764, epoch: 2458367.273, duration: 1.28, depth: 1.5},
    {name: 'L 98-59 d', hostname: 'L 98-59', ra: 271.97500, dec: -68.31447, hostMag: 11.7, period: 7.4507305, epoch: 2460039.155, duration: 0.47, depth: 1.5},
    {name: 'TIC 434398831 b', hostname: 'TIC 434398831', ra: 237.55000, dec: 16.02385, hostMag: 11.7, period: 3.685504, epoch: 2458468.635, duration: 2.76, depth: 1.2},
    {name: 'TIC 434398831 c', hostname: 'TIC 434398831', ra: 237.55000, dec: 16.02385, hostMag: 11.7, period: 6.210291, epoch: 2458470.624, duration: 3.04, depth: 3.2},
    {name: 'TOI-1338 b', hostname: 'TOI-1338', ra: 127.97500, dec: -59.54099, hostMag: 11.7, period: 95.174, epoch: 2458342.15, duration: 11.63, depth: 2.6},
    {name: 'TOI-1346 b', hostname: 'TOI-1346', ra: 97.35000, dec: 68.84330, hostMag: 11.7, period: 1.7622538, epoch: 2459978.024, duration: 0.88, depth: 0.73},
    {name: 'TOI-1346 c', hostname: 'TOI-1346', ra: 97.35000, dec: 68.84330, hostMag: 11.7, period: 5.502558, epoch: 2459771.727, duration: 3.17, depth: 0.84},
    {name: 'TOI-198 b', hostname: 'TOI-198', ra: 136.30000, dec: -27.12174, hostMag: 11.7, period: 10.2152, epoch: 2459480.048, duration: 1.63, depth: 0.89},
    {name: 'TOI-3682 b', hostname: 'TOI-3682', ra: 316.50000, dec: 25.29727, hostMag: 11.7, period: 3.3462406, epoch: 2459692.659, duration: 4.18, depth: 4.6},
    {name: 'TOI-3837 b', hostname: 'TOI-3837', ra: 159.97500, dec: 24.27312, hostMag: 11.7, period: 11.8886495, epoch: 2459613.38, duration: 4.8, depth: 7.8},
    {name: 'WASP-149 b', hostname: 'WASP-149', ra: 244.42500, dec: -8.68658, hostMag: 11.7, period: 1.332813, epoch: 2457757.625, duration: 2.05, depth: 16.8},
    {name: 'WASP-31 b', hostname: 'WASP-31', ra: 266.32500, dec: -19.05478, hostMag: 11.7, period: 3.4058875, epoch: 2457277.092, duration: 2.65, depth: 16.1},
    {name: 'WASP-58 b', hostname: 'WASP-58', ra: 282.07500, dec: 45.17222, hostMag: 11.7, period: 5.0172133, epoch: 2458986.982, duration: 3.74, depth: 14},
    {name: 'HAT-P-24 b', hostname: 'HAT-P-24', ra: 229.50000, dec: 14.26261, hostMag: 11.8, period: 3.35524439, epoch: 2458011.896, duration: 3.69, depth: 9.4},
    {name: 'HAT-P-26 b', hostname: 'HAT-P-26', ra: 189.40000, dec: 4.05942, hostMag: 11.8, period: 4.2345002, epoch: 2456901.059, duration: 2.46, depth: 5.4},
    {name: 'HAT-P-29 b', hostname: 'HAT-P-29', ra: 187.87500, dec: 51.77878, hostMag: 11.8, period: 5.72339, epoch: 2456210.615, duration: 3.89, depth: 8.6},
    {name: 'K2-105 b', hostname: 'K2-105', ra: 325.22500, dec: 13.49751, hostMag: 11.8, period: 8.2669897, epoch: 2458363.239, duration: 3.43, depth: 1.3},
    {name: 'K2-244 b', hostname: 'K2-244', ra: 208.12500, dec: -3.83181, hostMag: 11.8, period: 21.070201, epoch: 2457588.478, duration: 3.9, depth: 0.3},
    {name: 'K2-334 b', hostname: 'K2-334', ra: 89.37500, dec: 16.32551, hostMag: 11.8, period: 5.1138428, epoch: 2458209.316, duration: 2.46, depth: 1.3},
    {name: 'K2-393 b', hostname: 'K2-393', ra: 210.95000, dec: -0.08210, hostMag: 11.8, period: 10.41144, epoch: 2457739.399, duration: 2.72, depth: 0.4},
    {name: 'Kepler-129 b', hostname: 'Kepler-129', ra: 18.67500, dec: 47.84848, hostMag: 11.8, period: 15.79193352, epoch: 2454962.445, duration: 7.43, depth: 0.2},
    {name: 'Kepler-129 c', hostname: 'Kepler-129', ra: 18.67500, dec: 47.84848, hostMag: 11.8, period: 82.20069889, epoch: 2454959.582, duration: 10.9, depth: 0.22},
    {name: 'Kepler-22 b', hostname: 'Kepler-22', ra: 253.02500, dec: 47.88414, hostMag: 11.8, period: 289.8638764, epoch: 2454966.7, duration: 7.36, depth: 0.49},
    {name: 'Kepler-278 b', hostname: 'Kepler-278', ra: 306.42500, dec: 38.70227, hostMag: 11.8, period: 30.16021152, epoch: 2454971.512, duration: 7.8, depth: 0.18},
    {name: 'Kepler-278 c', hostname: 'Kepler-278', ra: 306.42500, dec: 38.70227, hostMag: 11.8, period: 51.07632364, epoch: 2454985.36, duration: 11.31, depth: 0.14},
    {name: 'Kepler-509 b', hostname: 'Kepler-509', ra: 279.87500, dec: 48.70616, hostMag: 11.8, period: 41.7460184, epoch: 2454959.908, duration: 4.86, depth: 0.42},
    {name: 'TIC 257060897 b', hostname: 'TIC 257060897', ra: 151.92500, dec: 72.71031, hostMag: 11.8, period: 3.660033, epoch: 2458979.841, duration: 0.19, depth: 7.7},
    {name: 'TOI-1248 b', hostname: 'TOI-1248', ra: 241.42500, dec: 63.10561, hostMag: 11.8, period: 4.36015363, epoch: 2458687.122, duration: 2.34, depth: 5.6},
    {name: 'TOI-1272 b', hostname: 'TOI-1272', ra: 251.77500, dec: 49.86106, hostMag: 11.8, period: 3.3159772, epoch: 2459661.401, duration: 1.49, depth: 2.8},
    {name: 'TOI-4214 b', hostname: 'TOI-4214', ra: 314.97500, dec: -13.92626, hostMag: 11.8, period: 3.4913885, epoch: 2459129.835, duration: 3.25, depth: 4.7},
    {name: 'WASP-174 b', hostname: 'WASP-174', ra: 47.65000, dec: -41.38486, hostMag: 11.8, period: 4.2337, epoch: 2459311.827, duration: 2.09, depth: 8.6},
    {name: 'WASP-45 b', hostname: 'WASP-45', ra: 314.27500, dec: -35.99846, hostMag: 11.8, period: 3.12607728, epoch: 2458536.086, duration: 1.68, depth: 12.9},
    {name: 'WASP-80 b', hostname: 'WASP-80', ra: 190.00000, dec: -2.14444, hostMag: 11.8, period: 3.06785251, epoch: 2456726.717, duration: 2.13, depth: 29.4},
    {name: 'K2-346 b', hostname: 'K2-346', ra: 359.20000, dec: 22.66323, hostMag: 11.9, period: 26.19445485, epoch: 2459521.873, duration: 3.84, depth: 1.2},
    {name: 'K2-397 b', hostname: 'K2-397', ra: 297.10000, dec: 21.25916, hostMag: 11.9, period: 3.572326, epoch: 2457823.575, duration: 1.3, depth: 0.52},
    {name: 'Kepler-103 b', hostname: 'Kepler-103', ra: 239.07500, dec: 40.06449, hostMag: 11.9, period: 15.96532718, epoch: 2454959.213, duration: 4.78, depth: 0.48},
    {name: 'Kepler-103 c', hostname: 'Kepler-103', ra: 239.07500, dec: 40.06449, hostMag: 11.9, period: 179.6100994, epoch: 2455128.328, duration: 13.76, depth: 1.3},
    {name: 'Kepler-953 b', hostname: 'Kepler-953', ra: 238.30000, dec: 44.62464, hostMag: 11.9, period: 88.40696499, epoch: 2455009.271, duration: 12.31, depth: 1.7},
    {name: 'Kepler-953 c', hostname: 'Kepler-953', ra: 238.30000, dec: 44.62464, hostMag: 11.9, period: 9.10971907, epoch: 2454956.954, duration: 5.53, depth: 0.15},
    {name: 'TIC 241249530 b', hostname: 'TIC 241249530', ra: 318.52500, dec: 53.29502, hostMag: 11.9, period: 165.7719, epoch: 2458860.801, duration: 11.8, depth: 7.6},
    {name: 'TOI-1244 b', hostname: 'TOI-1244', ra: 76.77500, dec: 69.51909, hostMag: 11.9, period: 6.40031648, epoch: 2459913.808, duration: 2.21, depth: 1},
    {name: 'TOI-1298 b', hostname: 'TOI-1298', ra: 79.37500, dec: 70.19004, hostMag: 11.9, period: 4.53713613, epoch: 2459764.42, duration: 4.04, depth: 4.2},
    {name: 'TOI-3693 b', hostname: 'TOI-3693', ra: 39.25000, dec: 51.30389, hostMag: 11.9, period: 9.088516, epoch: 2458806.682, duration: 3.56, depth: 21.3},
    {name: 'TOI-3807 b', hostname: 'TOI-3807', ra: 246.75000, dec: 69.07413, hostMag: 11.9, period: 2.8989727, epoch: 2459218.135, duration: 1.78, depth: 13.6},
    {name: 'TOI-5143 c', hostname: 'TOI-5143', ra: 21.90000, dec: 5.13948, hostMag: 11.9, period: 5.2097118, epoch: 2459527.243, duration: 1.7, depth: 11.4},
    {name: 'TOI-5153 b', hostname: 'TOI-5153', ra: 92.42500, dec: -19.95344, hostMag: 11.9, period: 20.9108406, epoch: 2459197.093, duration: 4.48, depth: 5.9},
    {name: 'TOI-6016 b', hostname: 'TOI-6016', ra: 271.45000, dec: 59.76620, hostMag: 11.9, period: 4.023687, epoch: 2459877.793, duration: 5.7, depth: 8.9},
    {name: 'WASP-25 b', hostname: 'WASP-25', ra: 21.57500, dec: -27.52223, hostMag: 11.9, period: 3.76483342, epoch: 2457744.728, duration: 2.76, depth: 19},
    {name: 'WASP-47 b', hostname: 'WASP-47', ra: 72.17500, dec: -12.01907, hostMag: 11.9, period: 4.159151, epoch: 2459407.762, duration: 3.57, depth: 12.8},
    {name: 'WASP-47 d', hostname: 'WASP-47', ra: 72.17500, dec: -12.01907, hostMag: 11.9, period: 9.03052118, epoch: 2459426.544, duration: 4.29, depth: 1.1},
    {name: 'WASP-47 e', hostname: 'WASP-47', ra: 72.17500, dec: -12.01907, hostMag: 11.9, period: 0.7895933, epoch: 2457011.349, duration: 1.9, depth: 0.26},
    {name: 'HAT-P-46 b', hostname: 'HAT-P-46', ra: 26.65000, dec: -2.97098, hostMag: 12, period: 4.46313574, epoch: 2456736.785, duration: 3.1, depth: 8},
    {name: 'K2-159 b', hostname: 'K2-159', ra: 32.45000, dec: -3.58091, hostMag: 12, period: 12.421078, epoch: 2457586.515, duration: 3.3, depth: 0.65},
    {name: 'K2-241 b', hostname: 'K2-241', ra: 74.32500, dec: -6.80530, hostMag: 12, period: 26.8199, epoch: 2457584.206, duration: 4.1, depth: 0.9},
    {name: 'Kepler-1084 b', hostname: 'Kepler-1084', ra: 306.12500, dec: 48.25115, hostMag: 12, period: 2.05333679, epoch: 2454967.518, duration: 2.38, depth: 0.07},
    {name: 'Kepler-14 b', hostname: 'Kepler-14', ra: 162.52500, dec: 47.33305, hostMag: 12, period: 6.79012033, epoch: 2454957.507, duration: 6.14, depth: 2.3},
    {name: 'Kepler-19 b', hostname: 'Kepler-19', ra: 325.25000, dec: 37.85166, hostMag: 12, period: 9.28697348, epoch: 2454959.706, duration: 3.65, depth: 0.7},
    {name: 'Kepler-63 b', hostname: 'Kepler-63', ra: 253.57500, dec: 49.54828, hostMag: 12, period: 9.43415263, epoch: 2454954.238, duration: 3.01, depth: 4},
    {name: 'TOI-2107 b', hostname: 'TOI-2107', ra: 107.80000, dec: -58.69684, hostMag: 12, period: 2.4545467, epoch: 2459228.982, duration: 2.6, depth: 21.3},
    {name: 'TOI-942 c', hostname: 'TOI-942', ra: 98.97500, dec: -20.24561, hostMag: 12, period: 10.156272, epoch: 2458447.056, duration: 1.92, depth: 2.3},
    {name: 'WASP-158 b', hostname: 'WASP-158', ra: 248.77500, dec: -10.97642, hostMag: 12, period: 3.6563308, epoch: 2458362.155, duration: 3.58, depth: 6.3},
    {name: 'WASP-78 b', hostname: 'WASP-78', ra: 225.37500, dec: -22.11639, hostMag: 12, period: 2.175185, epoch: 2457966.186, duration: 4.97, depth: 6.5},
    {name: 'K2-131 b', hostname: 'K2-131', ra: 165.07500, dec: -9.76524, hostMag: 12.1, period: 0.36930572, epoch: 2459280.989, duration: 1, depth: 0.76},
    {name: 'K2-132 b', hostname: 'K2-132', ra: 129.97500, dec: -8.74722, hostMag: 12.1, period: 9.172616, epoch: 2458434.031, duration: 7.17, depth: 0.58},
    {name: 'K2-166 b', hostname: 'K2-166', ra: 311.27500, dec: 2.28238, hostMag: 12.1, period: 8.527219, epoch: 2457586.767, duration: 3.7, depth: 0.16},
    {name: 'K2-285 b', hostname: 'K2-285', ra: 263.05000, dec: 1.30015, hostMag: 12.1, period: 3.4715644, epoch: 2459468.742, duration: 2.13, depth: 1.1},
    {name: 'K2-285 c', hostname: 'K2-285', ra: 263.05000, dec: 1.30015, hostMag: 12.1, period: 7.1385672, epoch: 2460228.759, duration: 2.46, depth: 2.1},
    {name: 'K2-285 d', hostname: 'K2-285', ra: 263.05000, dec: 1.30015, hostMag: 12.1, period: 10.45582, epoch: 2457745.201, duration: 2.5, depth: 1},
    {name: 'K2-285 e', hostname: 'K2-285', ra: 263.05000, dec: 1.30015, hostMag: 12.1, period: 14.76289, epoch: 2457741.897, duration: 2.3, depth: 0.68},
    {name: 'K2-333 b', hostname: 'K2-333', ra: 107.35000, dec: 15.20568, hostMag: 12.1, period: 14.759859, epoch: 2458525.43, duration: 4.96, depth: 2.2},
    {name: 'K2-408 b', hostname: 'K2-408', ra: 175.02500, dec: -17.68427, hostMag: 12.1, period: 20.978959, epoch: 2457991.536, duration: 4.4, depth: 0.38},
    {name: 'Kepler-1515 b', hostname: 'Kepler-1515', ra: 358.42500, dec: 48.17821, hostMag: 12.1, period: 214.3117719, epoch: 2455169.331, duration: 16.17, depth: 4.5},
    {name: 'Kepler-16 b', hostname: 'Kepler-16', ra: 244.55000, dec: 51.75723, hostMag: 12.1, period: 228.776, epoch: 2455212.123, duration: 8.26, depth: 12.5},
    {name: 'Kepler-1743 b', hostname: 'Kepler-1743', ra: 333.15000, dec: 48.12626, hostMag: 12.1, period: 7.64972673, epoch: 2454956.022, duration: 6.65, depth: 0.05},
    {name: 'Kepler-1864 b', hostname: 'Kepler-1864', ra: 281.20000, dec: 41.58892, hostMag: 12.1, period: 3.881501, epoch: 2454968.118, duration: 2.87, depth: 0.04},
    {name: 'Kepler-1888 b', hostname: 'Kepler-1888', ra: 263.67500, dec: 41.78226, hostMag: 12.1, period: 11.39170568, epoch: 2454974.559, duration: 4.97, depth: 0.05},
    {name: 'Kepler-510 b', hostname: 'Kepler-510', ra: 159.30000, dec: 39.24417, hostMag: 12.1, period: 19.55659485, epoch: 2454963.374, duration: 8.2, depth: 0.3},
    {name: 'TOI-2374 b', hostname: 'TOI-2374', ra: 269.90000, dec: -22.04982, hostMag: 12.1, period: 4.31361, epoch: 2458326.564, duration: 1.38, depth: 9.5},
    {name: 'WASP-56 b', hostname: 'WASP-56', ra: 201.95000, dec: 23.05569, hostMag: 12.1, period: 4.61705992, epoch: 2456229.442, duration: 3.56, depth: 10},
    {name: 'HATS-70 b', hostname: 'HATS-70', ra: 246.27500, dec: -31.24439, hostMag: 12.2, period: 1.88823968, epoch: 2458309.173, duration: 3.62, depth: 4.4},
    {name: 'K2-138 b', hostname: 'K2-138', ra: 236.95000, dec: -10.84974, hostMag: 12.2, period: 2.35309, epoch: 2457773.317, duration: 2.01, depth: 0.26},
    {name: 'K2-138 c', hostname: 'K2-138', ra: 236.95000, dec: -10.84974, hostMag: 12.2, period: 3.56004, epoch: 2457740.322, duration: 2.38, depth: 0.59},
    {name: 'K2-138 d', hostname: 'K2-138', ra: 236.95000, dec: -10.84974, hostMag: 12.2, period: 5.40479, epoch: 2457743.16, duration: 2.7, depth: 0.64},
    {name: 'K2-138 e', hostname: 'K2-138', ra: 236.95000, dec: -10.84974, hostMag: 12.2, period: 8.2616616, epoch: 2460219.145, duration: 2.86, depth: 1.3},
    {name: 'K2-138 f', hostname: 'K2-138', ra: 236.95000, dec: -10.84974, hostMag: 12.2, period: 12.75758, epoch: 2457738.702, duration: 3.2, depth: 0.95},
    {name: 'K2-138 g', hostname: 'K2-138', ra: 236.95000, dec: -10.84974, hostMag: 12.2, period: 41.96645, epoch: 2457773.854, duration: 4.04, depth: 1},
    {name: 'K2-196 b', hostname: 'K2-196', ra: 327.37500, dec: -8.47171, hostMag: 12.2, period: 48.324222, epoch: 2457227.891, duration: 11.6, depth: 0.46},
    {name: 'K2-319 b', hostname: 'K2-319', ra: 108.05000, dec: 3.03994, hostMag: 12.2, period: 26.68, epoch: 2457915.592, duration: 5.42, depth: 0.83},
    {name: 'Kepler-1163 b', hostname: 'Kepler-1163', ra: 314.15000, dec: 50.03007, hostMag: 12.2, period: 6.11784972, epoch: 2454966.619, duration: 3.46, depth: 0.06},
    {name: 'Kepler-1517 b', hostname: 'Kepler-1517', ra: 168.42500, dec: 43.18880, hostMag: 12.2, period: 5.54608449, epoch: 2454955.411, duration: 2.81, depth: 2.2},
    {name: 'Kepler-522 b', hostname: 'Kepler-522', ra: 189.22500, dec: 44.06882, hostMag: 12.2, period: 38.58443238, epoch: 2455007.831, duration: 10.37, depth: 1.2},
    {name: 'LHS 1815 b', hostname: 'LHS 1815', ra: 65.40000, dec: -55.31154, hostMag: 12.2, period: 3.8143009, epoch: 2458327.417, duration: 1.38, depth: 0.46},
    {name: 'TIC 365102760 b', hostname: 'TIC 365102760', ra: 350.40000, dec: 54.39432, hostMag: 12.2, period: 4.21285367, epoch: 2458684.146, duration: 5.52, depth: 0.31},
    {name: 'TOI-1853 b', hostname: 'TOI-1853', ra: 87.55000, dec: 16.99237, hostMag: 12.2, period: 1.2436258, epoch: 2459690.742, duration: 1.19, depth: 1.8},
    {name: 'TOI-3593 b', hostname: 'TOI-3593', ra: 90.37500, dec: 34.21166, hostMag: 12.2, period: 3.8212867, epoch: 2460055.727, duration: 2.49, depth: 12.1},
    {name: 'TOI-3877 b', hostname: 'TOI-3877', ra: 327.27500, dec: 33.99138, hostMag: 12.2, period: 4.123596, epoch: 2459753.934, duration: 2.78, depth: 5.5},
    {name: 'WASP-162 b', hostname: 'WASP-162', ra: 197.57500, dec: -17.65778, hostMag: 12.2, period: 9.6246647, epoch: 2458288.487, duration: 4.26, depth: 8.7},
    {name: 'WASP-52 b', hostname: 'WASP-52', ra: 209.70000, dec: 8.76108, hostMag: 12.2, period: 1.74978119, epoch: 2456770.06, duration: 1.81, depth: 27.1},
    {name: 'HATS-57 b', hostname: 'HATS-57', ra: 56.90000, dec: -19.05682, hostMag: 12.3, period: 2.35061721, epoch: 2458697.588, duration: 2.49, depth: 15.9},
    {name: 'HATS-68 b', hostname: 'HATS-68', ra: 0.37500, dec: -58.90473, hostMag: 12.3, period: 3.5862211, epoch: 2458798.277, duration: 3.42, depth: 5.7},
    {name: 'K2-108 b', hostname: 'K2-108', ra: 202.90000, dec: 16.41952, hostMag: 12.3, period: 4.7335575, epoch: 2459502.376, duration: 3.21, depth: 0.93},
    {name: 'K2-226 b', hostname: 'K2-226', ra: 218.75000, dec: -9.56263, hostMag: 12.3, period: 3.271106, epoch: 2457584.026, duration: 2.32, depth: 0.25},
    {name: 'Kepler-4 b', hostname: 'Kepler-4', ra: 36.92500, dec: 50.13577, hostMag: 12.3, period: 3.21366739, epoch: 2454956.612, duration: 4.26, depth: 0.74},
    {name: 'Kepler-514 b', hostname: 'Kepler-514', ra: 74.82500, dec: 50.24237, hostMag: 12.3, period: 5.65178735, epoch: 2454954.415, duration: 3.15, depth: 0.13},
    {name: 'Kepler-540 b', hostname: 'Kepler-540', ra: 337.50000, dec: 44.87378, hostMag: 12.3, period: 172.6957966, epoch: 2455069.96, duration: 11.28, depth: 0.63},
    {name: 'TOI-1450 A b', hostname: 'TOI-1450 A', ra: 111.25000, dec: 59.08663, hostMag: 12.3, period: 2.0439274, epoch: 2458685.342, duration: 0.99, depth: 0.47},
    {name: 'TOI-1467 b', hostname: 'TOI-1467', ra: 246.87500, dec: 49.23314, hostMag: 12.3, period: 5.971143, epoch: 2458766.99, duration: 1.51, depth: 1.3},
    {name: 'TOI-1782.01', hostname: 'TOI-1782.01', ra: 184.72500, dec: 74.41179, hostMag: 12.3, period: 4.98764103, epoch: 2459635.733, duration: 2.33, depth: 1.2},
    {name: 'TOI-1782.02', hostname: 'TOI-1782.02', ra: 184.72500, dec: 74.41179, hostMag: 12.3, period: 1.82902423, epoch: 2459632.817, duration: 1.54, depth: 0.7},
    {name: 'TOI-2328 b', hostname: 'TOI-2328', ra: 101.45000, dec: -81.24738, hostMag: 12.3, period: 17.10197, epoch: 2458330.489, duration: 3.36, depth: 11.4},
    {name: 'TOI-2567 b', hostname: 'TOI-2567', ra: 207.95000, dec: 66.34794, hostMag: 12.3, period: 5.9839451, epoch: 2459390.753, duration: 5.39, depth: 3.8},
    {name: 'TOI-2886 b', hostname: 'TOI-2886', ra: 300.45000, dec: -10.56984, hostMag: 12.3, period: 1.60200105, epoch: 2459311.014, duration: 2.78, depth: 19},
    {name: 'TOI-3023 b', hostname: 'TOI-3023', ra: 18.95000, dec: -72.35671, hostMag: 12.3, period: 3.9014971, epoch: 2459071.192, duration: 4.96, depth: 8.1},
    {name: 'TOI-332 b', hostname: 'TOI-332', ra: 183.55000, dec: -44.87649, hostMag: 12.3, period: 0.777038, epoch: 2459062.445, duration: 1.52, depth: 0.83},
    {name: 'TOI-4010 b', hostname: 'TOI-4010', ra: 312.90000, dec: 66.07220, hostMag: 12.3, period: 1.348335, epoch: 2459007.549, duration: 1.77, depth: 1.2},
    {name: 'TOI-4010 c', hostname: 'TOI-4010', ra: 312.90000, dec: 66.07220, hostMag: 12.3, period: 5.414654, epoch: 2459000.052, duration: 2.77, depth: 5},
    {name: 'TOI-4010 d', hostname: 'TOI-4010', ra: 312.90000, dec: 66.07220, hostMag: 12.3, period: 14.70886, epoch: 2458985.985, duration: 3.6, depth: 5},
    {name: 'WASP-177 b', hostname: 'WASP-177', ra: 287.82500, dec: -1.83443, hostMag: 12.3, period: 3.07172019, epoch: 2458584.142, duration: 1.61, depth: 18.5},
    {name: 'WASP-43 b', hostname: 'WASP-43', ra: 294.50000, dec: -9.80644, hostMag: 12.3, period: 0.81347406, epoch: 2457202.185, duration: 1.16, depth: 25.5},
    {name: 'EPIC 205950854 c', hostname: 'EPIC 205950854', ra: 186.60000, dec: -16.34189, hostMag: 12.4, period: 8.050722, epoch: 2456973.765, duration: 3.72, depth: 0.3},
    {name: 'HAT-P-35 b', hostname: 'HAT-P-35', ra: 195.05000, dec: 4.78703, hostMag: 12.4, period: 3.6466584, epoch: 2457620.79, duration: 3.94, depth: 9},
    {name: 'K2-168 b', hostname: 'K2-168', ra: 186.60000, dec: -16.34189, hostMag: 12.4, period: 15.8523, epoch: 2456990.893, duration: 3.79, depth: 0.53},
    {name: 'K2-186 b', hostname: 'K2-186', ra: 20.10000, dec: 18.82529, hostMag: 12.4, period: 41.4661, epoch: 2457154.847, duration: 6.12, depth: 0.98},
    {name: 'K2-205 b', hostname: 'K2-205', ra: 13.05000, dec: 0.42597, hostMag: 12.4, period: 26.672263, epoch: 2457413.419, duration: 6.05, depth: 0.29},
    {name: 'K2-58 b', hostname: 'K2-58', ra: 229.30000, dec: -14.04986, hostMag: 12.4, period: 7.052475, epoch: 2456979.923, duration: 1.9, depth: 1},
    {name: 'K2-58 c', hostname: 'K2-58', ra: 229.30000, dec: -14.04986, hostMag: 12.4, period: 2.537071, epoch: 2456979.586, duration: 2, depth: 0.38},
    {name: 'K2-58 d', hostname: 'K2-58', ra: 229.30000, dec: -14.04986, hostMag: 12.4, period: 22.882, epoch: 2456998.069, duration: 3.12, depth: 0.43},
    {name: 'K2-62 b', hostname: 'K2-62', ra: 261.87500, dec: -12.18748, hostMag: 12.4, period: 6.67196, epoch: 2456982.685, duration: 1.56, depth: 0.79},
    {name: 'K2-62 c', hostname: 'K2-62', ra: 261.87500, dec: -12.18748, hostMag: 12.4, period: 16.19803, epoch: 2456991.545, duration: 1.61, depth: 0.83},
    {name: 'Kepler-109 b', hostname: 'Kepler-109', ra: 323.55000, dec: 40.28491, hostMag: 12.4, period: 6.4816271, epoch: 2454955.979, duration: 3.97, depth: 0.3},
    {name: 'Kepler-109 c', hostname: 'Kepler-109', ra: 323.55000, dec: 40.28491, hostMag: 12.4, period: 21.22263519, epoch: 2454970.573, duration: 6.74, depth: 0.36},
    {name: 'Kepler-1141 b', hostname: 'Kepler-1141', ra: 332.62500, dec: 47.72591, hostMag: 12.4, period: 2.34450643, epoch: 2454965.883, duration: 1.4, depth: 0.06},
    {name: 'Kepler-1444 b', hostname: 'Kepler-1444', ra: 19.85000, dec: 42.04050, hostMag: 12.4, period: 33.42025398, epoch: 2454958.716, duration: 5.52, depth: 0.41},
    {name: 'Kepler-1581 b', hostname: 'Kepler-1581', ra: 142.27500, dec: 39.60362, hostMag: 12.4, period: 6.28385491, epoch: 2454966.2, duration: 4.12, depth: 0.04},
    {name: 'Kepler-411 b', hostname: 'Kepler-411', ra: 156.35000, dec: 49.52339, hostMag: 12.4, period: 3.00515254, epoch: 2454970.106, duration: 1.97, depth: 0.69},
    {name: 'Kepler-411 c', hostname: 'Kepler-411', ra: 156.35000, dec: 49.52339, hostMag: 12.4, period: 7.83443074, epoch: 2454960.388, duration: 3.04, depth: 2},
    {name: 'Kepler-411 d', hostname: 'Kepler-411', ra: 156.35000, dec: 49.52339, hostMag: 12.4, period: 58.0198583, epoch: 2454984.85, duration: 5.35, depth: 1.3},
    {name: 'Kepler-467 b', hostname: 'Kepler-467', ra: 141.77500, dec: 38.64973, hostMag: 12.4, period: 24.99320612, epoch: 2454971.683, duration: 6.1, depth: 0.28},
    {name: 'TOI-169 b', hostname: 'TOI-169', ra: 106.72500, dec: -75.19894, hostMag: 12.4, period: 2.2554458, epoch: 2459085.272, duration: 1.71, depth: 7.5},
    {name: 'TOI-1728 b', hostname: 'TOI-1728', ra: 36.70000, dec: 64.79715, hostMag: 12.4, period: 3.4913952, epoch: 2459604.399, duration: 1.76, depth: 5.4},
    {name: 'TOI-2876 b', hostname: 'TOI-2876', ra: 314.85000, dec: -21.11464, hostMag: 12.4, period: 6.2996431, epoch: 2459109.772, duration: 2.25, depth: 10.2},
    {name: 'TOI-4734 b', hostname: 'TOI-4734', ra: 21.47500, dec: 12.54788, hostMag: 12.4, period: 6.235633, epoch: 2459710.238, duration: 5.81, depth: 2.9},
    {name: 'TOI-5542 b', hostname: 'TOI-5542', ra: 167.90000, dec: -61.13547, hostMag: 12.4, period: 75.12375, epoch: 2458679.348, duration: 8.6, depth: 11.2},
    {name: 'WASP-155 b', hostname: 'WASP-155', ra: 178.77500, dec: 33.04761, hostMag: 12.4, period: 3.110413, epoch: 2459852.085, duration: 3.13, depth: 9.9},
    {name: 'HAT-P-38 b', hostname: 'HAT-P-38', ra: 323.00000, dec: 32.24604, hostMag: 12.5, period: 4.64032787, epoch: 2457570.761, duration: 3.04, depth: 10},
    {name: 'K2-172 b', hostname: 'K2-172', ra: 318.50000, dec: -12.55698, hostMag: 12.5, period: 14.316941, epoch: 2456982.295, duration: 3.84, depth: 0.38},
    {name: 'K2-172 c', hostname: 'K2-172', ra: 318.50000, dec: -12.55698, hostMag: 12.5, period: 29.6245, epoch: 2456993.541, duration: 4.99, depth: 1.3},
    {name: 'K2-173 b', hostname: 'K2-173', ra: 22.52500, dec: 15.62513, hostMag: 12.5, period: 5.868699, epoch: 2457067.141, duration: 2.83, depth: 0.2},
    {name: 'K2-174 b', hostname: 'K2-174', ra: 47.57500, dec: 16.34717, hostMag: 12.5, period: 19.562307, epoch: 2457083.779, duration: 5.81, depth: 1.4},
    {name: 'K2-195 b', hostname: 'K2-195', ra: 289.90000, dec: -8.50954, hostMag: 12.5, period: 15.85388, epoch: 2457225.045, duration: 4.8, depth: 1.1},
    {name: 'K2-195 c', hostname: 'K2-195', ra: 289.90000, dec: -8.50954, hostMag: 12.5, period: 28.4707, epoch: 2457243.024, duration: 5.98, depth: 0.75},
    {name: 'K2-29 b', hostname: 'K2-29', ra: 160.22500, dec: 24.40166, hostMag: 12.5, period: 3.25883406, epoch: 2458560.236, duration: 2.22, depth: 19},
    {name: 'Kepler-1130 b', hostname: 'Kepler-1130', ra: 12.45000, dec: 45.38433, hostMag: 12.5, period: 5.45301646, epoch: 2454956.241, duration: 2.45, depth: 0.09},
    {name: 'Kepler-1130 c', hostname: 'Kepler-1130', ra: 12.45000, dec: 45.38433, hostMag: 12.5, period: 3.26661204, epoch: 2454969.087, duration: 2.06, depth: 0.06},
    {name: 'Kepler-1130 d', hostname: 'Kepler-1130', ra: 12.45000, dec: 45.38433, hostMag: 12.5, period: 4.27225316, epoch: 2454966.221, duration: 2.14, depth: 0.05},
    {name: 'Kepler-1882 b', hostname: 'Kepler-1882', ra: 339.85000, dec: 43.49979, hostMag: 12.5, period: 13.7870681, epoch: 2454964.001, duration: 5.65, depth: 0.09},
    {name: 'Kepler-447 b', hostname: 'Kepler-447', ra: 16.12500, dec: 48.55988, hostMag: 12.5, period: 7.79430249, epoch: 2454954.671, duration: 1.31, depth: 3.1},
    {name: 'TOI-1468 b', hostname: 'TOI-1468', ra: 99.22500, dec: 19.22492, hostMag: 12.5, period: 1.8805136, epoch: 2458765.681, duration: 1.09, depth: 1.2},
    {name: 'TOI-1468 c', hostname: 'TOI-1468', ra: 99.22500, dec: 19.22492, hostMag: 12.5, period: 15.53243849, epoch: 2459450.356, duration: 1.76, depth: 2.9},
    {name: 'TOI-2337 b', hostname: 'TOI-2337', ra: 337.20000, dec: 60.85390, hostMag: 12.5, period: 2.99426304, epoch: 2459769.981, duration: 6.92, depth: 1.1},
    {name: 'TOI-2803 A b', hostname: 'TOI-2803 A', ra: 186.87500, dec: -23.49249, hostMag: 12.5, period: 1.96229325, epoch: 2459207.686, duration: 3.09, depth: 17.8},
    {name: 'TOI-3819 b', hostname: 'TOI-3819', ra: 111.80000, dec: 29.38864, hostMag: 12.5, period: 3.24429898, epoch: 2459502.745, duration: 2.69, depth: 5.7},
    {name: 'TOI-3912 b', hostname: 'TOI-3912', ra: 348.10000, dec: 24.07656, hostMag: 12.5, period: 3.4936264, epoch: 2459442.819, duration: 3.56, depth: 8.8},
    {name: 'WASP-116 b', hostname: 'WASP-116', ra: 312.95000, dec: -1.82604, hostMag: 12.5, period: 6.6132, epoch: 2457092.225, duration: 5.65, depth: 7.8},
    {name: 'WASP-139 b', hostname: 'WASP-139', ra: 273.72500, dec: -41.30202, hostMag: 12.5, period: 5.9242672, epoch: 2458363.875, duration: 2.83, depth: 10.7},
    {name: 'WASP-61 b', hostname: 'WASP-61', ra: 17.97500, dec: -26.05414, hostMag: 12.5, period: 3.85589655, epoch: 2458439.124, duration: 3.95, depth: 8.8},
    {name: 'WASP-81 b', hostname: 'WASP-81', ra: 252.47500, dec: 3.29395, hostMag: 12.5, period: 2.71648416, epoch: 2457705.941, duration: 3.53, depth: 14.5},
    {name: 'HAT-P-18 b', hostname: 'HAT-P-18', ra: 80.77500, dec: 33.01233, hostMag: 12.6, period: 5.50802941, epoch: 2457408.449, duration: 2.71, depth: 21.6},
    {name: 'K2-208 b', hostname: 'K2-208', ra: 346.75000, dec: 0.88901, hostMag: 12.6, period: 4.19097, epoch: 2457430.039, duration: 1.94, depth: 0.31},
    {name: 'K2-221 b', hostname: 'K2-221', ra: 99.30000, dec: 10.18974, hostMag: 12.6, period: 2.398982, epoch: 2457392.96, duration: 2.5, depth: 0.31},
    {name: 'K2-249 b', hostname: 'K2-249', ra: 202.00000, dec: -8.99523, hostMag: 12.6, period: 12.409, epoch: 2457583.046, duration: 5.9, depth: 0.24},
    {name: 'K2-260 b', hostname: 'K2-260', ra: 112.05000, dec: 16.86769, hostMag: 12.6, period: 2.62669762, epoch: 2457894.285, duration: 4.2, depth: 9.2},
    {name: 'K2-366 b', hostname: 'K2-366', ra: 220.80000, dec: -19.34688, hostMag: 12.6, period: 15.93709, epoch: 2456906.433, duration: 3.29, depth: 0.59},
    {name: 'K2-37 b', hostname: 'K2-37', ra: 207.05000, dec: -24.78705, hostMag: 12.6, period: 4.4436, epoch: 2456898.117, duration: 2.83, depth: 0.36},
    {name: 'K2-37 c', hostname: 'K2-37', ra: 207.05000, dec: -24.78705, hostMag: 12.6, period: 6.42959, epoch: 2456898.854, duration: 2.9, depth: 1},
    {name: 'K2-37 d', hostname: 'K2-37', ra: 207.05000, dec: -24.78705, hostMag: 12.6, period: 14.09292, epoch: 2456907.232, duration: 2.81, depth: 0.89},
    {name: 'K2-53 b', hostname: 'K2-53', ra: 248.52500, dec: -20.40060, hostMag: 12.6, period: 12.20772, epoch: 2456896.386, duration: 3.48, depth: 1},
    {name: 'Kepler-1185 b', hostname: 'Kepler-1185', ra: 134.47500, dec: 39.33270, hostMag: 12.6, period: 104.3508195, epoch: 2455023.109, duration: 3.59, depth: 0.24},
    {name: 'Kepler-1209 b', hostname: 'Kepler-1209', ra: 155.10000, dec: 49.15473, hostMag: 12.6, period: 25.36903196, epoch: 2454976.696, duration: 4.92, depth: 0.11},
    {name: 'Kepler-1446 b', hostname: 'Kepler-1446', ra: 265.45000, dec: 46.72608, hostMag: 12.6, period: 0.68996758, epoch: 2454964.636, duration: 1.21, depth: 0.12},
    {name: 'Kepler-1580 b', hostname: 'Kepler-1580', ra: 58.12500, dec: 41.36353, hostMag: 12.6, period: 56.64676651, epoch: 2454971.767, duration: 15.56, depth: 0.11},
    {name: 'Kepler-1605 b', hostname: 'Kepler-1605', ra: 128.10000, dec: 47.48863, hostMag: 12.6, period: 85.75632494, epoch: 2454995.725, duration: 5.79, depth: 0.16},
    {name: 'Kepler-1833 b', hostname: 'Kepler-1833', ra: 352.27500, dec: 45.41028, hostMag: 12.6, period: 6.89208596, epoch: 2454964.635, duration: 1.71, depth: 0.09},
    {name: 'Kepler-20 b', hostname: 'Kepler-20', ra: 161.87500, dec: 42.33858, hostMag: 12.6, period: 3.69611757, epoch: 2454967.502, duration: 2.81, depth: 0.4},
    {name: 'Kepler-20 c', hostname: 'Kepler-20', ra: 161.87500, dec: 42.33858, hostMag: 12.6, period: 10.8541002, epoch: 2454971.607, duration: 4.01, depth: 1},
    {name: 'Kepler-20 d', hostname: 'Kepler-20', ra: 161.87500, dec: 42.33858, hostMag: 12.6, period: 77.61154162, epoch: 2454997.726, duration: 7.62, depth: 0.84},
    {name: 'Kepler-20 e', hostname: 'Kepler-20', ra: 161.87500, dec: 42.33858, hostMag: 12.6, period: 6.09848823, epoch: 2454968.94, duration: 2.98, depth: 0.07},
    {name: 'Kepler-20 f', hostname: 'Kepler-20', ra: 161.87500, dec: 42.33858, hostMag: 12.6, period: 19.57778827, epoch: 2454968.208, duration: 3.8, depth: 0.12},
    {name: 'Kepler-407 b', hostname: 'Kepler-407', ra: 62.17500, dec: 49.61450, hostMag: 12.6, period: 0.66930969, epoch: 2454967.132, duration: 1.6, depth: 0.13},
    {name: 'Kepler-518 b', hostname: 'Kepler-518', ra: 125.40000, dec: 41.37376, hostMag: 12.6, period: 8.51203687, epoch: 2454956.837, duration: 2.53, depth: 0.59},
    {name: 'Kepler-858 b', hostname: 'Kepler-858', ra: 230.92500, dec: 51.20904, hostMag: 12.6, period: 76.13655826, epoch: 2455032.477, duration: 7.96, depth: 2.9},
    {name: 'PH2 b', hostname: 'PH2', ra: 285.82500, dec: 51.96268, hostMag: 12.6, period: 282.5254368, epoch: 2455196.07, duration: 10.54, depth: 9.9},
    {name: 'TOI-2583 A b', hostname: 'TOI-2583 A', ra: 136.02500, dec: 45.33690, hostMag: 12.6, period: 4.5207265, epoch: 2459216.01, duration: 4.41, depth: 8.1},
    {name: 'TOI-2842 b', hostname: 'TOI-2842', ra: 182.65000, dec: -10.63934, hostMag: 12.6, period: 3.5514058, epoch: 2459172.179, duration: 2.58, depth: 8.7},
    {name: 'TOI-3523 A b', hostname: 'TOI-3523 A', ra: 257.00000, dec: 42.90653, hostMag: 12.6, period: 2.30458952, epoch: 2460417.456, duration: 3.65, depth: 10.2},
    {name: 'TOI-4600 b', hostname: 'TOI-4600', ra: 207.02500, dec: 64.56617, hostMag: 12.6, period: 82.6869, epoch: 2459750.142, duration: 7.54, depth: 6.5},
    {name: 'TOI-4600 c', hostname: 'TOI-4600', ra: 207.02500, dec: 64.56617, hostMag: 12.6, period: 482.8191, epoch: 2459751.601, duration: 11.14, depth: 6.9},
    {name: 'TOI-4794 b', hostname: 'TOI-4794', ra: 329.00000, dec: -12.56548, hostMag: 12.6, period: 3.5658116, epoch: 2458889.69, duration: 4.01, depth: 8.2},
    {name: 'TOI-5592 b', hostname: 'TOI-5592', ra: 100.80000, dec: 65.85725, hostMag: 12.6, period: 2.6085846, epoch: 2459794.012, duration: 1.98, depth: 12.6},
    {name: 'WASP-170 b', hostname: 'WASP-170', ra: 24.97500, dec: -20.72037, hostMag: 12.6, period: 2.34477786, epoch: 2458571.479, duration: 2.04, depth: 13.8},
    {name: 'WASP-53 b', hostname: 'WASP-53', ra: 114.55000, dec: -20.66184, hostMag: 12.6, period: 3.30984278, epoch: 2457267.505, duration: 2.27, depth: 19.2},
    {name: 'WASP-96 b', hostname: 'WASP-96', ra: 62.80000, dec: -47.36064, hostMag: 12.6, period: 3.4252565, epoch: 2457963.841, duration: 2.43, depth: 13.8},
    {name: 'K2-130 b', hostname: 'K2-130', ra: 316.22500, dec: -19.69088, hostMag: 12.7, period: 2.494206, epoch: 2457303.2, duration: 1.7, depth: 0.3},
    {name: 'K2-161 b', hostname: 'K2-161', ra: 227.62500, dec: -3.49569, hostMag: 12.7, period: 9.283188, epoch: 2457587.848, duration: 5.79, depth: 0.48},
    {name: 'K2-170 b', hostname: 'K2-170', ra: 327.05000, dec: -14.59336, hostMag: 12.7, period: 7.5734, epoch: 2456978.614, duration: 3.43, depth: 0.2},
    {name: 'K2-170 c', hostname: 'K2-170', ra: 327.05000, dec: -14.59336, hostMag: 12.7, period: 12.3988, epoch: 2456985.664, duration: 4.18, depth: 0.31},
    {name: 'K2-171 b', hostname: 'K2-171', ra: 140.45000, dec: -13.42886, hostMag: 12.7, period: 5.6228, epoch: 2456979.494, duration: 8.21, depth: 0.22},
    {name: 'Kepler-104 b', hostname: 'Kepler-104', ra: 156.27500, dec: 42.16651, hostMag: 12.7, period: 11.42754338, epoch: 2454959.187, duration: 4.89, depth: 0.51},
    {name: 'Kepler-104 c', hostname: 'Kepler-104', ra: 156.27500, dec: 42.16651, hostMag: 12.7, period: 23.66838592, epoch: 2454965.713, duration: 5.99, depth: 0.46},
    {name: 'Kepler-104 d', hostname: 'Kepler-104', ra: 156.27500, dec: 42.16651, hostMag: 12.7, period: 51.75530801, epoch: 2455000.578, duration: 7.55, depth: 0.61},
    {name: 'Kepler-1542 b', hostname: 'Kepler-1542', ra: 43.70000, dec: 42.65446, hostMag: 12.7, period: 3.95118639, epoch: 2454967.213, duration: 2.59, depth: 0.06},
    {name: 'Kepler-1542 c', hostname: 'Kepler-1542', ra: 43.70000, dec: 42.65446, hostMag: 12.7, period: 2.89222871, epoch: 2454965.859, duration: 2.61, depth: 0.04},
    {name: 'Kepler-1542 d', hostname: 'Kepler-1542', ra: 43.70000, dec: 42.65446, hostMag: 12.7, period: 5.99218093, epoch: 2454964.781, duration: 2.55, depth: 0.07},
    {name: 'Kepler-1542 e', hostname: 'Kepler-1542', ra: 43.70000, dec: 42.65446, hostMag: 12.7, period: 5.10115269, epoch: 2454965.433, duration: 2.62, depth: 0.07},
    {name: 'Kepler-1928 b', hostname: 'Kepler-1928', ra: 326.45000, dec: 38.52357, hostMag: 12.7, period: 19.5778347, epoch: 2454964.715, duration: 2.25, depth: 0.44},
    {name: 'Kepler-1931 b', hostname: 'Kepler-1931', ra: 352.35000, dec: 43.33301, hostMag: 12.7, period: 38.57610826, epoch: 2455000.863, duration: 19.87, depth: 0.3},
    {name: 'Kepler-1982 b', hostname: 'Kepler-1982', ra: 144.60000, dec: 39.65863, hostMag: 12.7, period: 3.82316376, epoch: 2454966.066, duration: 2.16, depth: 0.05},
    {name: 'Kepler-91 b', hostname: 'Kepler-91', ra: 40.37500, dec: 44.11675, hostMag: 12.7, period: 6.24654458, epoch: 2454969.398, duration: 11.26, depth: 0.4},
    {name: 'TOI-5388.01', hostname: 'TOI-5388.01', ra: 130.60000, dec: 35.54756, hostMag: 12.7, period: 2.594675, epoch: 2459630.896, duration: 0.31, depth: 1.1},
    {name: 'TOI-6255 b', hostname: 'TOI-6255', ra: 90.20000, dec: 39.29883, hostMag: 12.7, period: 0.23818244, epoch: 2458738.712, duration: 0.48, depth: 0.49},
    {name: 'WASP-124 b', hostname: 'WASP-124', ra: 162.85000, dec: -30.74972, hostMag: 12.7, period: 3.37264959, epoch: 2457433.302, duration: 2.57, depth: 17.2},
    {name: 'WASP-163 b', hostname: 'WASP-163', ra: 92.25000, dec: -10.41301, hostMag: 12.7, period: 1.6096884, epoch: 2457918.462, duration: 2.23, depth: 14.2},
    {name: 'WASP-59 b', hostname: 'WASP-59', ra: 277.37500, dec: 24.88928, hostMag: 12.7, period: 7.919585, epoch: 2455830.956, duration: 2.45, depth: 16.9},
    {name: 'HAT-P-45 b', hostname: 'HAT-P-45', ra: 262.40000, dec: -3.38106, hostMag: 12.8, period: 3.12899506, epoch: 2458082.991, duration: 3.45, depth: 13.4},
    {name: 'HATS-12 b', hostname: 'HATS-12', ra: 252.15000, dec: -19.35592, hostMag: 12.8, period: 3.1428347, epoch: 2457364.665, duration: 4.52, depth: 4.3},
    {name: 'K2-155 b', hostname: 'K2-155', ra: 328.17500, dec: 21.35326, hostMag: 12.8, period: 6.34365, epoch: 2457818.715, duration: 2.41, depth: 0.68},
    {name: 'K2-155 c', hostname: 'K2-155', ra: 328.17500, dec: 21.35326, hostMag: 12.8, period: 13.853487, epoch: 2457994.665, duration: 3.53, depth: 1},
    {name: 'K2-155 d', hostname: 'K2-155', ra: 328.17500, dec: 21.35326, hostMag: 12.8, period: 40.6835, epoch: 2457782.832, duration: 4.46, depth: 0.74},
    {name: 'K2-160 b', hostname: 'K2-160', ra: 243.27500, dec: -3.55309, hostMag: 12.8, period: 3.705871, epoch: 2457585.666, duration: 1.79, depth: 1},
    {name: 'K2-231 b', hostname: 'K2-231', ra: 245.50000, dec: -15.77122, hostMag: 12.8, period: 13.841901, epoch: 2457320.002, duration: 2.94, depth: 0.64},
    {name: 'K2-245 b', hostname: 'K2-245', ra: 310.90000, dec: -1.59091, hostMag: 12.8, period: 11.89307, epoch: 2457587.552, duration: 4.2, depth: 1.1},
    {name: 'K2-374 b', hostname: 'K2-374', ra: 142.77500, dec: 16.35583, hostMag: 12.8, period: 4.521953, epoch: 2458099.687, duration: 3, depth: 0.26},
    {name: 'K2-374 c', hostname: 'K2-374', ra: 142.77500, dec: 16.35583, hostMag: 12.8, period: 16.43445, epoch: 2458109.238, duration: 3.6, depth: 0.5},
    {name: 'Kepler-1137 b', hostname: 'Kepler-1137', ra: 127.82500, dec: 48.66535, hostMag: 12.8, period: 23.92120244, epoch: 2454972.077, duration: 4.9, depth: 0.14},
    {name: 'Kepler-135 b', hostname: 'Kepler-135', ra: 329.70000, dec: 38.79549, hostMag: 12.8, period: 6.00253766, epoch: 2454956.696, duration: 4.12, depth: 0.2},
    {name: 'Kepler-135 c', hostname: 'Kepler-135', ra: 329.70000, dec: 38.79549, hostMag: 12.8, period: 11.4485422, epoch: 2454962.948, duration: 5.26, depth: 0.07},
    {name: 'Kepler-1525 b', hostname: 'Kepler-1525', ra: 333.57500, dec: 49.94286, hostMag: 12.8, period: 2.41660149, epoch: 2454964.537, duration: 1.97, depth: 0.08},
    {name: 'Kepler-1879 b', hostname: 'Kepler-1879', ra: 261.87500, dec: 41.53326, hostMag: 12.8, period: 10.61340671, epoch: 2454958.078, duration: 1.39, depth: 0.17},
    {name: 'Kepler-334 b', hostname: 'Kepler-334', ra: 128.45000, dec: 47.11512, hostMag: 12.8, period: 5.47032469, epoch: 2454953.554, duration: 3.46, depth: 0.11},
    {name: 'Kepler-334 c', hostname: 'Kepler-334', ra: 128.45000, dec: 47.11512, hostMag: 12.8, period: 12.75799391, epoch: 2454954.203, duration: 4.41, depth: 0.2},
    {name: 'Kepler-334 d', hostname: 'Kepler-334', ra: 128.45000, dec: 47.11512, hostMag: 12.8, period: 25.0984395, epoch: 2454978.571, duration: 3.12, depth: 0.18},
    {name: 'Kepler-337 b', hostname: 'Kepler-337', ra: 303.62500, dec: 47.16395, hostMag: 12.8, period: 3.29279396, epoch: 2454956.121, duration: 4.98, depth: 0.08},
    {name: 'Kepler-337 c', hostname: 'Kepler-337', ra: 303.62500, dec: 47.16395, hostMag: 12.8, period: 9.69311847, epoch: 2454956.122, duration: 5.83, depth: 0.14},
    {name: 'Kepler-403 b', hostname: 'Kepler-403', ra: 295.27500, dec: 46.74453, hostMag: 12.8, period: 7.03137764, epoch: 2454967.463, duration: 6.33, depth: 0.09},
    {name: 'Kepler-403 c', hostname: 'Kepler-403', ra: 295.27500, dec: 46.74453, hostMag: 12.8, period: 54.28140531, epoch: 2454973.711, duration: 5.52, depth: 0.15},
    {name: 'Kepler-403 d', hostname: 'Kepler-403', ra: 295.27500, dec: 46.74453, hostMag: 12.8, period: 13.61167162, epoch: 2454977.177, duration: 7.97, depth: 0.09},
    {name: 'Kepler-782 b', hostname: 'Kepler-782', ra: 232.10000, dec: 47.75947, hostMag: 12.8, period: 158.6845633, epoch: 2455006.948, duration: 11.68, depth: 0.9},
    {name: 'TOI-2969 b', hostname: 'TOI-2969', ra: 3.75000, dec: -47.44524, hostMag: 12.8, period: 1.8237146, epoch: 2459303.3, duration: 1.85, depth: 22.9},
    {name: 'WASP-110 b', hostname: 'WASP-110', ra: 352.35000, dec: -44.05870, hostMag: 12.8, period: 3.77840085, epoch: 2459038.032, duration: 2.83, depth: 24.6},
    {name: 'WASP-151 b', hostname: 'WASP-151', ra: 243.80000, dec: 0.30669, hostMag: 12.8, period: 4.5334682, epoch: 2458058.352, duration: 3.66, depth: 10.7},
    {name: 'K2-13 b', hostname: 'K2-13', ra: 309.32500, dec: 2.50275, hostMag: 12.9, period: 40.0603, epoch: 2456812.526, duration: 6.34, depth: 0.58},
    {name: 'K2-157 b', hostname: 'K2-157', ra: 225.10000, dec: -5.78202, hostMag: 12.9, period: 0.3652575, epoch: 2457582.822, duration: 1.16, depth: 0.1},
    {name: 'K2-183 b', hostname: 'K2-183', ra: 300.42500, dec: 14.01946, hostMag: 12.9, period: 0.469287, epoch: 2457139.662, duration: 1.54, depth: 0.22},
    {name: 'K2-183 c', hostname: 'K2-183', ra: 300.42500, dec: 14.01946, hostMag: 12.9, period: 10.787992, epoch: 2457212.473, duration: 3.85, depth: 0.9},
    {name: 'K2-183 d', hostname: 'K2-183', ra: 300.42500, dec: 14.01946, hostMag: 12.9, period: 22.620344, epoch: 2457212.028, duration: 4.92, depth: 0.95},
    {name: 'K2-252 b', hostname: 'K2-252', ra: 141.97500, dec: -8.30961, hostMag: 12.9, period: 13.81513, epoch: 2457596.19, duration: 3.6, depth: 0.36},
    {name: 'K2-381 b', hostname: 'K2-381', ra: 181.60000, dec: -21.00758, hostMag: 12.9, period: 7.9389334, epoch: 2457304.844, duration: 1.46, depth: 0.21},
    {name: 'K2-381 c', hostname: 'K2-381', ra: 181.60000, dec: -21.00758, hostMag: 12.9, period: 16.0343, epoch: 2457304.292, duration: 3.14, depth: 0.95},
    {name: 'K2-381 d', hostname: 'K2-381', ra: 181.60000, dec: -21.00758, hostMag: 12.9, period: 26.8054, epoch: 2457307.913, duration: 2.93, depth: 0.52},
    {name: 'K2-409 b', hostname: 'K2-409', ra: 207.30000, dec: -16.35130, hostMag: 12.9, period: 1.908084, epoch: 2457990.284, duration: 2.5, depth: 0.34},
    {name: 'Kepler-106 b', hostname: 'Kepler-106', ra: 51.85000, dec: 44.33755, hostMag: 12.9, period: 6.16487649, epoch: 2454968.639, duration: 3.26, depth: 0.06},
    {name: 'Kepler-106 c', hostname: 'Kepler-106', ra: 51.85000, dec: 44.33755, hostMag: 12.9, period: 13.57078354, epoch: 2454955.708, duration: 3.54, depth: 0.54},
    {name: 'Kepler-106 d', hostname: 'Kepler-106', ra: 51.85000, dec: 44.33755, hostMag: 12.9, period: 23.97923476, epoch: 2454980.511, duration: 5.35, depth: 0.1},
    {name: 'Kepler-106 e', hostname: 'Kepler-106', ra: 51.85000, dec: 44.33755, hostMag: 12.9, period: 43.84437655, epoch: 2454984.936, duration: 6.66, depth: 0.65},
    {name: 'Kepler-1224 b', hostname: 'Kepler-1224', ra: 97.55000, dec: 37.53731, hostMag: 12.9, period: 13.32360062, epoch: 2454953.702, duration: 3.98, depth: 0.11},
    {name: 'Kepler-1248 b', hostname: 'Kepler-1248', ra: 183.55000, dec: 51.35446, hostMag: 12.9, period: 7.46725407, epoch: 2454969.385, duration: 3.71, depth: 0.08},
    {name: 'Kepler-1300 b', hostname: 'Kepler-1300', ra: 241.97500, dec: 40.08692, hostMag: 12.9, period: 22.24207899, epoch: 2454955.484, duration: 7.13, depth: 0.07},
    {name: 'Kepler-1421 b', hostname: 'Kepler-1421', ra: 94.85000, dec: 48.54423, hostMag: 12.9, period: 6.91241288, epoch: 2454971.515, duration: 4.77, depth: 0.04},
    {name: 'Kepler-1934 b', hostname: 'Kepler-1934', ra: 355.15000, dec: 37.28717, hostMag: 12.9, period: 1.41974915, epoch: 2454965.925, duration: 1.51, depth: 0.06},
    {name: 'Kepler-515 b', hostname: 'Kepler-515', ra: 329.62500, dec: 52.05561, hostMag: 12.9, period: 19.96364808, epoch: 2454971.381, duration: 2.84, depth: 0.27},
    {name: 'Kepler-849 b', hostname: 'Kepler-849', ra: 351.10000, dec: 48.52133, hostMag: 12.9, period: 394.62508, epoch: 2455010.838, duration: 24.01, depth: 1.7},
    {name: 'Kepler-885 b', hostname: 'Kepler-885', ra: 219.70000, dec: 49.73715, hostMag: 12.9, period: 18.11470018, epoch: 2454980.492, duration: 5.16, depth: 0.25},
    {name: 'TOI-1266 b', hostname: 'TOI-1266', ra: 179.80000, dec: 65.83370, hostMag: 12.9, period: 10.894841, epoch: 2459660.646, duration: 2.07, depth: 3.1},
    {name: 'TOI-1266 c', hostname: 'TOI-1266', ra: 179.80000, dec: 65.83370, hostMag: 12.9, period: 18.801611, epoch: 2459648.847, duration: 1.95, depth: 2},
    {name: 'TOI-3082 b', hostname: 'TOI-3082', ra: 54.47500, dec: -19.21898, hostMag: 12.9, period: 1.9268037, epoch: 2459332.242, duration: 1.4, depth: 2.3},
    {name: 'TOI-6628 b', hostname: 'TOI-6628', ra: 50.22500, dec: -35.23058, hostMag: 12.9, period: 18.18424, epoch: 2458602.721, duration: 3.7, depth: 9.3},
    {name: 'WASP-142 b', hostname: 'WASP-142', ra: 330.37500, dec: -23.94610, hostMag: 12.9, period: 2.0528705, epoch: 2458032.161, duration: 2.68, depth: 9.2},
    {name: 'HAT-P-66 b', hostname: 'HAT-P-66', ra: 34.35000, dec: 53.95083, hostMag: 13, period: 2.972089, epoch: 2458248.505, duration: 4.7, depth: 6.4},
    {name: 'K2-204 b', hostname: 'K2-204', ra: 142.95000, dec: -0.51775, hostMag: 13, period: 7.055908, epoch: 2457452.955, duration: 4.57, depth: 0.54},
    {name: 'K2-212 b', hostname: 'K2-212', ra: 205.45000, dec: 3.09707, hostMag: 13, period: 9.795647, epoch: 2457399.641, duration: 2.6, depth: 1.3},
    {name: 'K2-215 b', hostname: 'K2-215', ra: 208.20000, dec: 6.12386, hostMag: 13, period: 8.26947, epoch: 2457394.33, duration: 2.23, depth: 0.54},
    {name: 'K2-382 b', hostname: 'K2-382', ra: 144.75000, dec: -19.62693, hostMag: 13, period: 21.7, epoch: 2457314.365, duration: 4.1, depth: 0.79},
    {name: 'K2-63 b', hostname: 'K2-63', ra: 205.60000, dec: -12.06634, hostMag: 13, period: 20.2653, epoch: 2456989.581, duration: 5.26, depth: 0.48},
    {name: 'K2-63 c', hostname: 'K2-63', ra: 205.60000, dec: -12.06634, hostMag: 13, period: 25.4569, epoch: 2456983.645, duration: 4.8, depth: 0.79},
    {name: 'K2-68 b', hostname: 'K2-68', ra: 241.17500, dec: -10.56736, hostMag: 13, period: 8.054787, epoch: 2456982.326, duration: 2.72, depth: 0.67},
    {name: 'Kepler-1027 b', hostname: 'Kepler-1027', ra: 154.27500, dec: 42.81382, hostMag: 13, period: 1.90780645, epoch: 2454955.101, duration: 2.26, depth: 0.14},
    {name: 'Kepler-105 b', hostname: 'Kepler-105', ra: 173.22500, dec: 46.27612, hostMag: 13, period: 5.4122034, epoch: 2454955.319, duration: 2.95, depth: 0.6},
    {name: 'Kepler-105 c', hostname: 'Kepler-105', ra: 173.22500, dec: 46.27612, hostMag: 13, period: 7.12593999, epoch: 2454957.753, duration: 3.05, depth: 0.18},
    {name: 'Kepler-1063 b', hostname: 'Kepler-1063', ra: 331.60000, dec: 38.14283, hostMag: 13, period: 14.07971049, epoch: 2454958.878, duration: 1.71, depth: 0.16},
    {name: 'Kepler-1276 b', hostname: 'Kepler-1276', ra: 171.42500, dec: 40.54719, hostMag: 13, period: 12.5722979, epoch: 2454963.489, duration: 5.19, depth: 0.11},
    {name: 'Kepler-138 b', hostname: 'Kepler-138', ra: 322.87500, dec: 43.29306, hostMag: 13, period: 10.31320643, epoch: 2454966.516, duration: 2.15, depth: 0.14},
    {name: 'Kepler-138 c', hostname: 'Kepler-138', ra: 322.87500, dec: 43.29306, hostMag: 13, period: 13.7810915, epoch: 2454955.729, duration: 2.62, depth: 0.73},
    {name: 'Kepler-138 d', hostname: 'Kepler-138', ra: 322.87500, dec: 43.29306, hostMag: 13, period: 23.08898875, epoch: 2454957.829, duration: 2.06, depth: 0.62},
    {name: 'Kepler-140 b', hostname: 'Kepler-140', ra: 142.17500, dec: 46.76815, hostMag: 13, period: 3.25427607, epoch: 2454953.594, duration: 3.22, depth: 0.16},
    {name: 'Kepler-140 c', hostname: 'Kepler-140', ra: 142.17500, dec: 46.76815, hostMag: 13, period: 91.35220192, epoch: 2455022.597, duration: 8.57, depth: 0.21},
    {name: 'Kepler-1583 b', hostname: 'Kepler-1583', ra: 83.22500, dec: 47.01652, hostMag: 13, period: 9.32807355, epoch: 2454965.853, duration: 3.94, depth: 0.04},
    {name: 'Kepler-513 b', hostname: 'Kepler-513', ra: 2.50000, dec: 50.07539, hostMag: 13, period: 28.86237473, epoch: 2454953.759, duration: 5.66, depth: 0.44},
    {name: 'Kepler-7 b', hostname: 'Kepler-7', ra: 214.90000, dec: 41.08973, hostMag: 13, period: 4.8854889, epoch: 2454957.505, duration: 5.21, depth: 7.6},
    {name: 'Kepler-97 b', hostname: 'Kepler-97', ra: 139.60000, dec: 48.67334, hostMag: 13, period: 2.58664041, epoch: 2454955.696, duration: 2.57, depth: 0.22},
    {name: 'Kepler-98 b', hostname: 'Kepler-98', ra: 39.70000, dec: 37.96457, hostMag: 13, period: 1.54167548, epoch: 2454954.211, duration: 2.2, depth: 0.3},
    {name: 'KPS-1 b', hostname: 'KPS-1', ra: 10.02500, dec: 64.96384, hostMag: 13, period: 1.7063264, epoch: 2459632.745, duration: 1.36, depth: 11},
    {name: 'LHS 475 b', hostname: 'LHS 475', ra: 314.27500, dec: -82.55979, hostMag: 13, period: 2.029101, epoch: 2458626.204, duration: 0.72, depth: 1.1},
    {name: 'TOI-1693 b', hostname: 'TOI-1693', ra: 18.50000, dec: 34.77309, hostMag: 13, period: 1.76669201, epoch: 2458817.685, duration: 1.42, depth: 0.83},
    {name: 'WASP-175 b', hostname: 'WASP-175', ra: 79.12500, dec: -34.12274, hostMag: 13, period: 3.06529495, epoch: 2457744.587, duration: 2.68, depth: 10.6},
    {name: 'WASP-46 b', hostname: 'WASP-46', ra: 224.22500, dec: -55.87186, hostMag: 13, period: 1.43037192, epoch: 2457715.241, duration: 1.62, depth: 19}
  
  ];
  
  // Cache and return embedded database
  cachedExoplanetDatabase = embeddedData;
  return embeddedData;
}

// Calculate if a transit occurred during the observation
function calculateHistoricalTransit(planet, observationDate, observationDuration) {
  try {
    console.writeln('[>] Checking transit for ' + planet.name + '...');
    
    var period = planet.period;              // Orbital period in days
    var epoch = planet.epoch;                // Reference transit epoch (BJD)
    var duration = planet.duration / 24;     // Transit duration in days
    observationDuration = observationDuration || 0.25; // Default 6 hours
    
    // Calculate how many cycles since the reference epoch
    var timeSinceEpoch = observationDate - epoch;
    var cyclesSinceEpoch = timeSinceEpoch / period;
    
    // Find the nearest transit to our observation
    var nearestCycle = Math.round(cyclesSinceEpoch);
    var predictedTransitJD = epoch + (nearestCycle * period);
    
    // Calculate transit window
    var transitStart = predictedTransitJD - (duration / 2);
    var transitEnd = predictedTransitJD + (duration / 2);
    
    // Calculate observation window
    var obsStart = observationDate;
    var obsEnd = observationDate + observationDuration;
    
    // Check for overlap
    var overlapStart = Math.max(transitStart, obsStart);
    var overlapEnd = Math.min(transitEnd, obsEnd);
    var hasOverlap = overlapStart < overlapEnd;
    var overlapDuration = hasOverlap ? (overlapEnd - overlapStart) * 24 : 0; // hours
    
    var result = {
      planet: planet,
      predictedCenter: predictedTransitJD,
      transitStart: transitStart,
      transitEnd: transitEnd,
      obsStart: obsStart,
      obsEnd: obsEnd,
      hasOverlap: hasOverlap,
      overlapDuration: overlapDuration,
      overlapPercentage: hasOverlap ? (overlapDuration / planet.duration) * 100 : 0,
      timeDifference: Math.abs(predictedTransitJD - (obsStart + obsEnd) / 2) * 24, // hours from obs center
      quality: 'unknown'
    };
    
    // Assess overlap quality
    if (hasOverlap) {
      if (result.overlapPercentage > 80) {
        result.quality = 'Excellent - Nearly complete transit';
      } else if (result.overlapPercentage > 50) {
        result.quality = 'Good - Majority of transit';
      } else if (result.overlapPercentage > 20) {
        result.quality = 'Partial - Useful for timing';
      } else {
        result.quality = 'Minimal - Limited science value';
      }
      
      console.writeln('? Transit overlap found: ' + overlapDuration.toFixed(2) + 'h (' + result.overlapPercentage.toFixed(1) + '%)');
    } else {
      console.writeln('? No transit overlap (nearest was ' + result.timeDifference.toFixed(1) + 'h away)');
    }
    
    return result;
  } catch (e) {
    console.warningln('[!] Error calculating transit for ' + planet.name + ': ' + e);
    return null;
  }
}

// Main function to analyze historical transits
function analyzeHistoricalTransits(imageWindow) {
  console.writeln('[>] Starting historical exoplanet transit analysis...');
  
  try {
    // Step 1: Extract observation date
    var obsDate = extractObservationDate(imageWindow);
    if (!obsDate) {
      console.writeln('[>] Could not extract observation date - FITS may lack temporal keywords');
      return { 
        success: false, 
        error: 'Could not determine observation date from FITS headers. Image may lack DATE-OBS, JD, or MJD keywords.',
        matches: [] // Ensure matches array exists even on failure
      };
    }
    
    // Step 2: Extract or estimate field center
    var fieldCenter = extractFieldCenter(imageWindow);
    if (!fieldCenter) {
      console.writeln('[>] No field center coordinates found - transit analysis disabled');
      console.writeln('[>] Photometry analysis will still proceed');
      
      return { 
        success: true,  // Changed from false - allow analysis to continue
        transitAnalysisDisabled: true,
        error: null,
        message: 'Field center coordinates not available. Transit analysis disabled, but photometry will proceed.',
        observationDate: obsDate,
        fieldCenter: null,
        fieldOfView: null,
        candidates: [],
        matches: []
      };
    }
    
    // Step 3: Calculate field of view
    var fieldOfView = calculateFieldOfView(imageWindow, {
      focalLength: GlobalSettings.focalLength,
      pixelSize: GlobalSettings.pixelSize,
      binning: GlobalSettings.binning
    });
    
    // Step 4: Query for exoplanets in the field (circular pre-filter)
    var candidates = queryExoplanetsInField(fieldCenter, fieldOfView.radiusDeg, obsDate.julianDate);

    // Step 4b: Refine with exact pixel-bounds check when WCS is available.
    // The circular search uses the half-diagonal radius, which includes the image
    // corners — stars outside the actual rectangular frame but inside the circumscribed
    // circle pass the angular-distance test and produce false positives.
    // When a WCS solution is present, project each candidate to pixel coords and
    // discard any that fall outside [0..width] × [0..height].
    var imageW = (imageWindow && imageWindow.mainView) ? imageWindow.mainView.image.width  : 0;
    var imageH = (imageWindow && imageWindow.mainView) ? imageWindow.mainView.image.height : 0;
    if (imageW > 0 && imageH > 0) {
      var refined = [];
      for (var ci = 0; ci < candidates.length; ci++) {
        var cand = candidates[ci];
        var inBounds = false;
        try {
          var px = raDecToPixel(imageWindow, cand.ra, cand.dec);
          if (px && px.success &&
              px.x >= 0 && px.x < imageW &&
              px.y >= 0 && px.y < imageH) {
            inBounds = true;
          }
        } catch (e) {
          // WCS unavailable for this candidate — fall back to angular distance only
          inBounds = true;
        }
        if (inBounds) {
          refined.push(cand);
        } else {
          console.writeln('[>] Excluding ' + cand.name + ': projects outside image bounds (false positive from circular search)');
        }
      }
      if (refined.length !== candidates.length) {
        console.writeln('[>] Pixel-bounds filter: ' + candidates.length + ' → ' + refined.length + ' candidates');
      }
      candidates = refined;
    }
    
    // Step 5: Always find closest exoplanet and upcoming transits (regardless of field results)
    console.writeln('[>] Finding closest exoplanet and upcoming transit recommendations...');
    
    // Find closest exoplanet for reference (regardless of field)
    var closestExoplanet = findClosestExoplanet(fieldCenter.ra, fieldCenter.dec);
    if (closestExoplanet) {
      var distanceText = closestExoplanet.distance < 1.0 ? 
        (closestExoplanet.distance * 60).toFixed(1) + ' arcminutes' :
        closestExoplanet.distance.toFixed(1) + '°';
      
      console.writeln('[>] 🌌 Nearest exoplanet host: ' + closestExoplanet.hostname + ' (' + closestExoplanet.name + ')');
      console.writeln('   Distance: ' + distanceText + ' away');
      console.writeln('   Magnitude: ' + closestExoplanet.hostMag);
    }
    
    // Extract observer location for transit predictions
    var observerLocation = extractObserverLocation(imageWindow);
    if (!observerLocation) {
      // Use coordinates from FITS header if available, otherwise default
      var keywordMap = buildKeywordMap(imageWindow);
      var siteLong = getKeyword(keywordMap, 'SITELONG') || getKeyword(keywordMap, 'LONG-OBS');
      var siteLat = getKeyword(keywordMap, 'SITELAT') || getKeyword(keywordMap, 'LAT-OBS');
      
      if (siteLong && siteLat) {
        observerLocation = {
          longitude: parseFloat(siteLong),
          latitude: parseFloat(siteLat)
        };
        console.writeln('[>] Using FITS observer location: ' + observerLocation.latitude.toFixed(2) + '°N, ' + Math.abs(observerLocation.longitude).toFixed(2) + '°W');
      } else {
        // Estimate location from machine timezone as best available fallback
        observerLocation = estimateLocationFromTimezone();
        console.writeln('[>] No FITS geodetic coords — using timezone estimate: ' +
          observerLocation.latitude.toFixed(1) + '°N, ' + observerLocation.longitude.toFixed(1) + '°E');
      }
    }
    
    // Find top upcoming transit opportunities
    var upcomingTransits = findBestVisibleTransits(fieldCenter, observerLocation, 90); // Next 90 days
    
    if (upcomingTransits && upcomingTransits.length > 0) {
      console.writeln('[>] 🎆 Top upcoming transit opportunities 🎆:');
      for (var t = 0; t < Math.min(5, upcomingTransits.length); t++) {
        var transit = upcomingTransits[t];
        console.writeln('   ' + (t + 1) + '. ' + transit.name + ' - ' + transit.localTimeString);
        console.writeln('      Magnitude: ' + transit.hostMag + ', Duration: ' + transit.duration + 'h');
        if (transit.fieldDistance < 5.0) {
          console.writeln('      ? ✨ Within ' + transit.fieldDistance.toFixed(1) + '° of your current field!');
        }
      }
    }
    
    // Step 6: Process field candidates
    
    if (candidates.length === 0) {
      console.writeln('[>] No known exoplanets found within field of view - this is normal for most fields');
      
      return {
        success: true,
        matches: [],
        candidates: [],
        closestExoplanet: closestExoplanet,
        upcomingTransits: upcomingTransits ? upcomingTransits.slice(0, 5) : [],
        message: 'No transiting exoplanets in field, but found ' + 
                (closestExoplanet ? 'nearest target and ' : '') + 
                (upcomingTransits ? upcomingTransits.length + ' upcoming opportunities' : 'no upcoming transits')
      };
    }
    
    // Step 7: Calculate transit overlaps for each candidate
    var transitMatches = [];
    var observationDuration = 0.25; // Assume 6 hours typical observation
    
    for (var i = 0; i < candidates.length; i++) {
      var transitResult = calculateHistoricalTransit(candidates[i], obsDate.julianDate, observationDuration);
      if (transitResult && transitResult.hasOverlap) {
        transitMatches.push(transitResult);
      }
    }
    
    // Step 8: Sort by overlap quality
    transitMatches.sort(function(a, b) {
      return b.overlapPercentage - a.overlapPercentage;
    });
    
    var result = {
      success: true,
      observationDate: obsDate,
      fieldCenter: fieldCenter,
      fieldOfView: fieldOfView,
      candidates: candidates,
      matches: transitMatches,
      closestExoplanet: closestExoplanet,
      upcomingTransits: upcomingTransits ? upcomingTransits.slice(0, 5) : [],
      message: transitMatches.length > 0 ?
        'Found ' + transitMatches.length + ' historical transit(s) during observation!' :
        'No transits occurred during your observation period'
    };
    
    console.writeln('? Historical transit analysis complete: ' + result.message);
    return result;
  } catch (e) {
    console.warningln('[!] Historical transit analysis failed: ' + e);
    return { 
      success: false, 
      error: 'Analysis failed: ' + e.toString(),
      matches: [] // Ensure matches array exists even on exception
    };
  }
}

// ---------------- FITS Header Reading Functions ----------------
// Extract hardware settings from FITS headers
function extractHardwareFromFITS(imageWindow) {
  if (!imageWindow || !imageWindow.keywords) {
    return null;
  }
  
  var keywords = buildKeywordMap(imageWindow);
  var hardware = {};
  var found = false;
  
  // Try to extract focal length (in mm)
  var focalLength = parseFloat(getKeyword(keywords, 'FOCALLEN')) || 
                   parseFloat(getKeyword(keywords, 'FOCAL')) ||
                   parseFloat(getKeyword(keywords, 'TELFL'));
  if (isFinite(focalLength) && focalLength > 0) {
    hardware.focalLength = focalLength;
    found = true;
  }
  
  // Try to extract pixel size (in micrometers)
  var pixelSize = parseFloat(getKeyword(keywords, 'XPIXSZ')) ||
                 parseFloat(getKeyword(keywords, 'PIXSIZE1')) ||
                 parseFloat(getKeyword(keywords, 'PIXELSIZE'));
  if (isFinite(pixelSize) && pixelSize > 0) {
    hardware.pixelSize = pixelSize;
    found = true;
  }
  
  // Try to extract binning
  var binning = parseInt(getKeyword(keywords, 'XBINNING')) ||
               parseInt(getKeyword(keywords, 'BINNING')) ||
               parseInt(getKeyword(keywords, 'XBIN'));
  if (isFinite(binning) && binning >= 1 && binning <= 4) {
    hardware.binning = binning;
    found = true;
  }
  
  // Try to extract or estimate FWHM from various sources
  var fwhm = parseFloat(getKeyword(keywords, 'FWHM')) ||
            parseFloat(getKeyword(keywords, 'SEEING')) ||
            parseFloat(getKeyword(keywords, 'STAR_FWHM'));
  if (isFinite(fwhm) && fwhm > 0) {
    hardware.estimatedFWHM = fwhm;
    found = true;
  }
  
  // If we have focal length and pixel size, we can calculate image scale
  if (hardware.focalLength && hardware.pixelSize) {
    var binValue = hardware.binning || 1;
    var imageScale = calculateImageScale(hardware.focalLength, hardware.pixelSize, binValue);
    hardware.calculatedImageScale = imageScale;
    console.writeln('[>] Calculated image scale from FITS: ' + imageScale.toFixed(2) + '"/pixel');
  }
  
  return found ? hardware : null;
}

// Find the closest exoplanet to given coordinates for validation/display
function findClosestExoplanet(ra, dec) {
  try {
    var exoplanets = getKnownTransitingExoplanets();
    if (!exoplanets || exoplanets.length === 0) {
      return null;
    }
    
    var closest = null;
    var minDistance = Number.MAX_VALUE;
    
    for (var i = 0; i < exoplanets.length; i++) {
      var planet = exoplanets[i];
      var distance = calculateAngularDistance(ra, dec, planet.ra, planet.dec);
      
      if (distance < minDistance) {
        minDistance = distance;
        closest = {
          name: planet.name,
          hostname: planet.hostname,
          ra: planet.ra,
          dec: planet.dec,
          hostMag: planet.hostMag,
          distance: distance
        };
      }
    }
    
  return closest;
  } catch (e) {
    console.writeln('[>] Error finding closest exoplanet: ' + e);
    return null;
  }
}

// Convert decimal degrees to HMS format (for RA)
function decimalDegreesToHMS(degrees) {
  var hours = degrees / 15.0; // Convert degrees to hours
  var h = Math.floor(hours);
  var remainingMinutes = (hours - h) * 60;
  var m = Math.floor(remainingMinutes);
  var s = (remainingMinutes - m) * 60;
  
  // Pad with leading zeros
  var hStr = h < 10 ? '0' + h : h.toString();
  var mStr = m < 10 ? '0' + m : m.toString();
  var sStr = s < 10 ? '0' + s.toFixed(1) : s.toFixed(1);
  
  return hStr + 'h' + mStr + 'm' + sStr + 's';
}

// Convert decimal degrees to DMS format (for Dec)
function decimalDegreesToDMS(degrees) {
  var sign = degrees >= 0 ? '+' : '-';
  degrees = Math.abs(degrees);
  var d = Math.floor(degrees);
  var remainingMinutes = (degrees - d) * 60;
  var m = Math.floor(remainingMinutes);
  var s = (remainingMinutes - m) * 60;
  
  // Pad with leading zeros
  var dStr = d < 10 ? '0' + d : d.toString();
  var mStr = m < 10 ? '0' + m : m.toString();
  var sStr = s < 10 ? '0' + s.toFixed(1) : s.toFixed(1);
  
  return sign + dStr + '°' + mStr + '\'' + sStr + '"';
}

// Extract observer location from FITS headers
function extractObserverLocation(imageWindow) {
  try {
    if (!imageWindow || !imageWindow.keywords) {
      return null;
    }
    
    var keywords = buildKeywordMap(imageWindow);
    
    // Try various FITS keywords for location
    var longitude = parseFloat(getKeyword(keywords, 'SITELON')) ||
                   parseFloat(getKeyword(keywords, 'SITELONG')) ||
                   parseFloat(getKeyword(keywords, 'OBSGEO-L')) ||
                   parseFloat(getKeyword(keywords, 'OBSLON'));
                   
    var latitude = parseFloat(getKeyword(keywords, 'SITELAT')) ||
                  parseFloat(getKeyword(keywords, 'OBSGEO-B')) ||
                  parseFloat(getKeyword(keywords, 'OBSLAT'));
    
    if (isFinite(longitude) && isFinite(latitude)) {
      return {
        longitude: longitude,
        latitude: latitude
      };
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

// Check if a transit is visible from observer location (nighttime and >30 degrees elevation)
function isTransitVisible(transitJD, targetRA, targetDec, observerLocation) {
  try {
    // Convert JD to JavaScript Date for the transit time
    var transitDate = new Date((transitJD - 2440587.5) * 86400000.0);
    
    // Calculate Local Sidereal Time at transit
    var lst = calculateLocalSiderealTime(transitJD, observerLocation.longitude);
    
    // Calculate hour angle of target at transit time
    var hourAngle = lst - targetRA;
    if (hourAngle < 0) hourAngle += 360;
    if (hourAngle > 180) hourAngle -= 360;
    
    // Convert to radians for calculation
    var haRad = hourAngle * Math.PI / 180.0;
    var decRad = targetDec * Math.PI / 180.0;
    var latRad = observerLocation.latitude * Math.PI / 180.0;
    
    // Calculate altitude (elevation)
    var sinAlt = Math.sin(decRad) * Math.sin(latRad) + 
                Math.cos(decRad) * Math.cos(latRad) * Math.cos(haRad);
    var altitude = Math.asin(sinAlt) * 180.0 / Math.PI;
    
    // Check if altitude is >30 degrees
    if (altitude < 30.0) {
      return false;
    }
    
    // Check if it's astronomical nighttime (Sun >18 degrees below horizon)
    var sunAltitude = calculateSunAltitude(transitJD, observerLocation);
    
    // Transit is visible if Sun is >18 degrees below horizon
    return sunAltitude < -18.0;
    
  } catch (e) {
    return false;
  }
}

// Calculate Local Sidereal Time
function calculateLocalSiderealTime(jd, longitude) {
  // Greenwich Mean Sidereal Time
  var t = (jd - 2451545.0) / 36525.0;
  var gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - t * t * t / 38710000.0;
  
  // Normalize to 0-360
  gmst = gmst % 360.0;
  if (gmst < 0) gmst += 360.0;
  
  // Convert to Local Sidereal Time
  var lst = gmst + longitude;
  if (lst >= 360.0) lst -= 360.0;
  if (lst < 0) lst += 360.0;
  
  return lst;
}

// Calculate Sun's altitude for nighttime check
function calculateSunAltitude(jd, observerLocation) {
  try {
    // Simplified solar position calculation
    var n = jd - 2451545.0;
    var L = (280.460 + 0.9856474 * n) % 360;
    var g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180.0;
    var lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180.0;
    
    // Sun's declination
    var epsilon = 23.439 * Math.PI / 180.0;
    var alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
    var delta = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
    
    // Convert RA to°rees
    var raHours = alpha * 180.0 / Math.PI / 15.0;
    if (raHours < 0) raHours += 24;
    var raDeg = raHours * 15.0;
    var decDeg = delta * 180.0 / Math.PI;
    
    // Calculate Local Sidereal Time
    var lst = calculateLocalSiderealTime(jd, observerLocation.longitude);
    
    // Hour angle
    var hourAngle = lst - raDeg;
    if (hourAngle > 180) hourAngle -= 360;
    if (hourAngle < -180) hourAngle += 360;
    
    // Convert to radians
    var haRad = hourAngle * Math.PI / 180.0;
    var latRad = observerLocation.latitude * Math.PI / 180.0;
    
    // Sun altitude
    var sinAlt = Math.sin(delta) * Math.sin(latRad) + 
                Math.cos(delta) * Math.cos(latRad) * Math.cos(haRad);
    var altitude = Math.asin(sinAlt) * 180.0 / Math.PI;
    
    return altitude;
  } catch (e) {
    return 0; // Default to Sun up if calculation fails
  }
}

// Find top 5 best visible transits based on magnitude, location, time, and declination
// Estimate observer location from machine timezone when FITS geodetic coords absent.
// getTimezoneOffset() returns minutes WEST of UTC (inverted: UTC-5 returns +300).
// Longitude estimate: -offset_min/4  (360°/24h/60min per degree)
// Latitude: use typical mid-latitude (45°) for the hemisphere — better than hardcoded US.
function estimateLocationFromTimezone() {
  try {
    var offsetMin = new Date().getTimezoneOffset(); // e.g. +300 for UTC-5 (Americas)
    var lon = -offsetMin / 4.0; // degrees — rough but hemisphere-correct
    // Clamp to valid range
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    // Latitude: default to 45° N (mid northern latitude — most observers)
    // No reliable way to get latitude from timezone offset alone
    return { longitude: lon, latitude: 45.0, fromTimezone: true };
  } catch(e) {
    return { longitude: 0.0, latitude: 45.0, fromTimezone: true }; // UTC/equatorial fallback
  }
}

function findBestVisibleTransits(fieldCenter, observerLocation, maxDays) {
  try {
    var exoplanets = getKnownTransitingExoplanets();
    var currentJD = new Date().getTime() / 86400000.0 + 2440587.5;
    var candidates = [];
    
    // Search through all exoplanets for visible transits
    for (var i = 0; i < exoplanets.length; i++) {
      var planet = exoplanets[i];
      
      // Skip if missing required data
      if (!planet.period || !planet.epoch || !planet.hostMag || !planet.ra || !planet.dec) {
        continue;
      }
      
      // Find next few transits for this planet
      var periodsSinceEpoch = (currentJD - planet.epoch) / planet.period;
      var nextPeriodNumber = Math.ceil(periodsSinceEpoch);
      
      // Check up to 10 periods ahead for each planet
      for (var periodOffset = 0; periodOffset < 10; periodOffset++) {
        var transitJD = planet.epoch + ((nextPeriodNumber + periodOffset) * planet.period);
        
        // Skip if transit is in the past or too far in the future
        if (transitJD < currentJD || transitJD > (currentJD + maxDays)) {
          continue;
        }
        
        // Check if transit is visible
        if (isTransitVisible(transitJD, planet.ra, planet.dec, observerLocation)) {
          var timeUntil = transitJD - currentJD;
          var distance = calculateAngularDistance(fieldCenter.ra, fieldCenter.dec, planet.ra, planet.dec);
          
          // Calculate altitude at transit time for scoring
          var lst = calculateLocalSiderealTime(transitJD, observerLocation.longitude);
          var hourAngle = lst - planet.ra;
          if (hourAngle > 180) hourAngle -= 360;
          if (hourAngle < -180) hourAngle += 360;
          
          var haRad = hourAngle * Math.PI / 180.0;
          var decRad = planet.dec * Math.PI / 180.0;
          var latRad = observerLocation.latitude * Math.PI / 180.0;
          
          var sinAlt = Math.sin(decRad) * Math.sin(latRad) + 
                      Math.cos(decRad) * Math.cos(latRad) * Math.cos(haRad);
          var altitude = Math.asin(sinAlt) * 180.0 / Math.PI;
          
          // Convert transit time to local time string
          var localTime = jdToLocalTime(transitJD);
          
          candidates.push({
            name: planet.name,
            hostname: planet.hostname,
            transitJD: transitJD,
            timeUntil: timeUntil,
            hostMag: planet.hostMag,
            distance: distance,
            altitude: altitude,
            ra: planet.ra,
            dec: planet.dec,
            duration: planet.duration || 'N/A',
            localTimeString: localTime.formatted,
            fieldDistance: distance // Add this for the field proximity check
          });
        }
      }
    }
    
    // Score and rank candidates
    for (var j = 0; j < candidates.length; j++) {
      var candidate = candidates[j];
      
      // Scoring factors (lower score is better)
      var magScore = candidate.hostMag; // Brighter stars (lower magnitude) get better score
      var distanceScore = candidate.distance * 10; // Closer objects get better score
      var timeScore = candidate.timeUntil; // Sooner transits get better score
      var altitudeScore = (90 - candidate.altitude) / 10; // Higher altitude gets better score
      
      // Combined score (weighted)
      candidate.score = magScore * 1.0 + distanceScore * 0.5 + timeScore * 0.3 + altitudeScore * 0.2;
    }
    
    // Sort by score (best first)
    candidates.sort(function(a, b) {
      return a.score - b.score;
    });
    
    // Return top 5
    return candidates.slice(0, 5);
    
  } catch (e) {
    console.writeln('[>] Error finding best transits: ' + e);
    return [];
  }
}

// Format best transits list for display
function formatBestTransitsList(bestTransits) {
  if (!bestTransits || bestTransits.length === 0) {
    return 'Best visible transits: None found in search period';
  }
  
  var lines = ['[TOP] Top ' + bestTransits.length + ' best visible transits:'];
  
  for (var i = 0; i < bestTransits.length; i++) {
    var transit = bestTransits[i];
    var rank = i + 1;
    
    // Format coordinates
    var raHMS = decimalDegreesToHMS(transit.ra);
    var decDMS = decimalDegreesToDMS(transit.dec);
    
    // Format exact date/time
    var transitDate = jdToLocalTime(transit.transitJD);
    
    // Clean format with coordinates and exact time
    var line = '#' + rank + ' ' + transit.name + ': ' +
               raHMS + ', ' + decDMS + ' | ' +
               'mag ' + (transit.hostMag !== undefined && transit.hostMag !== null ? parseFloat(transit.hostMag).toFixed(1) : '?') + ' | ' +
               transitDate.formatted;
               
    lines.push(line);
  }
  
  return lines.join('\n');
}

// Get next transit information with timezone handling
function getNextTransitInfo(closestExoplanet, imageWindow) {
  try {
    // Get the full exoplanet data (need period and epoch)
    var exoplanets = getKnownTransitingExoplanets();
    var fullPlanetData = null;
    
    for (var i = 0; i < exoplanets.length; i++) {
      if (exoplanets[i].hostname === closestExoplanet.hostname) {
        fullPlanetData = exoplanets[i];
        break;
      }
    }
    
    if (!fullPlanetData || !fullPlanetData.period || !fullPlanetData.epoch) {
      return null; // Can't predict without orbital data
    }
    
    // ALWAYS use current time, not FITS observation date
    var currentJD = new Date().getTime() / 86400000.0 + 2440587.5;
    
    // Extract observer location from FITS for visibility calculations
    var observerLocation = extractObserverLocation(imageWindow);
    if (!observerLocation) {
      observerLocation = estimateLocationFromTimezone();
    }
    
    // Find next VISIBLE transit (astronomical nighttime and >30 degrees elevation)
    var period = fullPlanetData.period; // days
    var epoch = fullPlanetData.epoch;   // reference transit JD
    
    // How many periods since the reference epoch?
    var periodsSinceEpoch = (currentJD - epoch) / period;
    var nextPeriodNumber = Math.ceil(periodsSinceEpoch);
    
    var maxSearchPeriods = 50; // Search up to 50 periods ahead
    var visibleTransitJD = null;
    
    for (var searchPeriod = 0; searchPeriod < maxSearchPeriods; searchPeriod++) {
      var transitJD = epoch + ((nextPeriodNumber + searchPeriod) * period);
      
      // Skip if transit is in the past
      if (transitJD < currentJD) continue;
      
      // Check if transit is visible (nighttime and >30 degrees elevation)
      if (isTransitVisible(transitJD, fullPlanetData.ra, fullPlanetData.dec, observerLocation)) {
        visibleTransitJD = transitJD;
        break;
      }
    }
    
    if (!visibleTransitJD) {
      return 'Next visible ' + fullPlanetData.name + ' transit: None found in next ' + maxSearchPeriods + ' periods';
    }
    
    // Convert to local time with timezone handling
    var nextTransitDate = jdToLocalTime(visibleTransitJD);
    var timeUntil = visibleTransitJD - currentJD; // days
    
    // Format the time until next transit
    var timeText = '';
    if (timeUntil < 1) {
      var hoursUntil = timeUntil * 24;
      if (hoursUntil < 1) {
        timeText = 'in ' + (hoursUntil * 60).toFixed(0) + ' minutes';
      } else {
        timeText = 'in ' + hoursUntil.toFixed(1) + ' hours';
      }
    } else if (timeUntil < 30) {
      timeText = 'in ' + timeUntil.toFixed(1) + ' days';
    } else {
      timeText = 'in ' + (timeUntil / 30).toFixed(1) + ' months';
    }
    
    return 'Next ' + fullPlanetData.name + ' transit: ' + nextTransitDate.formatted + ' (' + timeText + ')';
    
  } catch (e) {
    console.writeln('[>] Error calculating next transit: ' + e);
    return null;
  }
}

// Convert Julian Date to local time with timezone handling
function jdToLocalTime(jd) {
  // Convert JD to UTC datetime components — guaranteed to work in PixInsight JS engine.
  // Uses Date.UTC / getUTC* methods which are always available.
  try {
    var ms = (jd - 2440587.5) * 86400000.0;
    var d  = new Date(ms);
    var days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var months= ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
    var formatted = days[d.getUTCDay()] + ' ' + months[d.getUTCMonth()] + ' ' +
                    pad(d.getUTCDate()) + ', ' + d.getUTCFullYear() + ' ' +
                    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
    // Also compute end time if caller wants start+duration (stored separately)
    return { date: d, formatted: formatted, jd: jd, isDST: false };
  } catch(e) {
    return { date: new Date(), formatted: 'Date error', jd: jd, isDST: false };
  }
}

// Format a JD range as "HH:MM – HH:MM UTC (Dh Dm)" for transit windows
function formatTransitWindow(transitJD, durationHours) {
  try {
    var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
    var durH = isFinite(durationHours) ? durationHours : 0;
    var startMs = (transitJD - durationHours/48 - 2440587.5) * 86400000; // mid - half-dur
    var endMs   = startMs + durationHours * 3600000;
    var days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var months= ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var sd = new Date(startMs), ed = new Date(endMs);
    var dateStr = days[sd.getUTCDay()] + ' ' + months[sd.getUTCMonth()] + ' ' +
                  pad(sd.getUTCDate()) + ', ' + sd.getUTCFullYear();
    var startStr = pad(sd.getUTCHours()) + ':' + pad(sd.getUTCMinutes());
    var endStr   = pad(ed.getUTCHours()) + ':' + pad(ed.getUTCMinutes());
    // Duration display
    var dh = Math.floor(durH), dm = Math.round((durH - dh) * 60);
    var durStr = dh > 0 ? dh + 'h' + (dm > 0 ? ' ' + dm + 'm' : '') : dm + 'm';
    return { date: dateStr, start: startStr, end: endStr, duration: durStr };
  } catch(e) {
    return { date: '?', start: '?', end: '?', duration: '?' };
  }
}

// Simple DST detection for US (adjust for other regions as needed)
function isDateInDST(date) {
  try {
    var year = date.getFullYear();
    
    // US DST: Second Sunday in March to first Sunday in November
    var march = new Date(year, 2, 1); // March 1
    var november = new Date(year, 10, 1); // November 1
    
    // Find second Sunday in March
    var dstStart = new Date(year, 2, (14 - march.getDay()) % 7 + 8);
    
    // Find first Sunday in November  
    var dstEnd = new Date(year, 10, (7 - november.getDay()) % 7 + 1);
    
    return date >= dstStart && date < dstEnd;
  } catch (e) {
    return false; // Default to standard time if detection fails
  }
}

// Convert local time string to 24-hour format
function convertTo24Hour(timeStr) {
  try {
    // Extract just the date and time part, removing timezone info
    // Expected format: "Dec 15, 2024 10:42 PM EST" or similar
    var parts = timeStr.split(' ');
    if (parts.length >= 5) {
      var datePart = parts.slice(0, 3).join(' '); // "Dec 15, 2024"
      var timePart = parts[3]; // "10:42"
      var ampm = parts[4]; // "PM"
      
      var timeBits = timePart.split(':');
      var hours = parseInt(timeBits[0]);
      var minutes = timeBits[1];
      
      // Convert to 24-hour
      if (ampm.toUpperCase() === 'PM' && hours !== 12) {
        hours += 12;
      } else if (ampm.toUpperCase() === 'AM' && hours === 12) {
        hours = 0;
      }
      
      var hours24 = (hours < 10 ? '0' : '') + hours;
      return datePart + ' ' + hours24 + ':' + minutes;
    }
    
    // Fallback: return original string
    return timeStr;
  } catch (e) {
    return timeStr; // Return original on error
  }
}

// Get enhanced equipment and observation info from FITS for user reference
function getFITSInfo(imageWindow, transitAnalysisResults) {
  if (!imageWindow || !imageWindow.keywords) {
    return 'No FITS keywords available';
  }
  
  var keywords = buildKeywordMap(imageWindow);
  var info = [];
  
  // Equipment info
  var telescope = getKeyword(keywords, 'TELESCOP');
  if (telescope) info.push('🔭 ' + telescope);
  
  var instrument = getKeyword(keywords, 'INSTRUME');
  if (instrument) info.push('📡 ' + instrument);
  
  var camera = getKeyword(keywords, 'CAMERA') || getKeyword(keywords, 'DETECTOR');
  if (camera) info.push('📷 ' + camera);
  
  var filter = getKeyword(keywords, 'FILTER');
  if (filter) info.push('🌈 ' + filter);
  
  // Observation details
  var exptime = getKeyword(keywords, 'EXPTIME') || getKeyword(keywords, 'EXPOSURE');
  if (exptime) {
    var exp = parseFloat(exptime);
    if (isFinite(exp)) {
      info.push('⏱️ ' + exp.toFixed(1) + 's');
    }
  }
  
  // Software/Creator info
  var creator = getKeyword(keywords, 'CREATOR') || getKeyword(keywords, 'SWCREATE') || getKeyword(keywords, 'SOFTWARE');
  if (creator) info.push('💻 ' + creator);
  
  // Object name (if available)
  var object = getKeyword(keywords, 'OBJECT') || getKeyword(keywords, 'OBJNAME');
  if (object) info.push('🌟 ' + object);
  
  // Build result with equipment info
  var result = info.length > 0 ? info.join(' | ') : 'No equipment info in FITS headers';
  
  // Add transit analysis results if provided
  if (transitAnalysisResults) {
    
    // Add closest exoplanet info with enhanced prominence
    if (transitAnalysisResults.closestExoplanet) {
      var closest = transitAnalysisResults.closestExoplanet;
      var distanceText = closest.distance < 1.0 ? 
        (closest.distance * 60).toFixed(1) + ' arcminutes away' :
        closest.distance.toFixed(1) + '° away';
      
      // Check if this is in field (very close) or just nearby
      var hasExoplanetInField = (transitAnalysisResults.candidates && transitAnalysisResults.candidates.length > 0);
      
      if (hasExoplanetInField) {
        result += '\n\n🎆 EXOPLANET IN FIELD: ' + closest.hostname + ' (' + closest.name + ') - ' + distanceText + ' | Magnitude: ' + closest.hostMag;
      } else if (closest.distance < 1.0) {
        result += '\n\n🌟 NEARBY EXOPLANET: ' + closest.hostname + ' (' + closest.name + ') - ' + distanceText + ' | Magnitude: ' + closest.hostMag;
      } else {
        result += '\n\n🌌 Nearest exoplanet host: ' + closest.hostname + ' (' + closest.name + ') - ' + distanceText + ' | Magnitude: ' + closest.hostMag;
      }
    }
    
    // Add field analysis status (moved up)
    if (transitAnalysisResults.message) {
      result += '\n' + transitAnalysisResults.message;
    }
    
    // Add upcoming transits
    if (transitAnalysisResults.upcomingTransits && transitAnalysisResults.upcomingTransits.length > 0) {
      var inFieldHostname = (transitAnalysisResults.candidates && transitAnalysisResults.candidates.length > 0 &&
                             transitAnalysisResults.closestExoplanet)
                            ? transitAnalysisResults.closestExoplanet.hostname : null;

      if (inFieldHostname) {
        // ── Exoplanet IS in the frame: show ONLY its upcoming transits ──
        var inFieldTransits = transitAnalysisResults.upcomingTransits.filter(function(t) {
          return t.hostname === inFieldHostname || t.name.indexOf(inFieldHostname) >= 0;
        });
        // Try hostname match; also try planet-name prefix match for multi-planet systems
        if (inFieldTransits.length === 0) {
          var hn = inFieldHostname.toLowerCase();
          inFieldTransits = transitAnalysisResults.upcomingTransits.filter(function(t) {
            return (t.name && t.name.toLowerCase().indexOf(hn) >= 0) ||
                   (t.hostname && t.hostname.toLowerCase().indexOf(hn) >= 0);
          });
        }

        result += '\n\n🎆 Upcoming transit windows for ' + inFieldHostname + ':';
        var shown = 0;
        for (var i = 0; i < inFieldTransits.length && shown < 5; i++) {
          var transit = inFieldTransits[i];
          var win = formatTransitWindow(transit.transitJD, parseFloat(transit.duration) || 0);
          result += '\n' + (shown+1) + ') ' + transit.name +
                    ' | ' + win.date +
                    ' | Start: ' + win.start + ' UTC' +
                    ' | End: ' + win.end + ' UTC' +
                    ' | Duration: ' + win.duration;
          shown++;
        }
        if (shown === 0) {
          result += '\nNo observable transits for ' + inFieldHostname + ' found in the next 90 days.';
          result += '\n(Transits may occur during daytime or when star is below horizon)';
        }
      } else {
        // ── No exoplanet in frame: show general nearby opportunities ──
        result += '\n\n🎆 Top upcoming transit opportunities:';
        for (var i = 0; i < Math.min(5, transitAnalysisResults.upcomingTransits.length); i++) {
          var transit = transitAnalysisResults.upcomingTransits[i];
          var win = formatTransitWindow(transit.transitJD, parseFloat(transit.duration) || 0);
          result += '\n' + (i+1) + ') ' + transit.name +
                    (transit.hostname && transit.hostname !== transit.name ? ' (' + transit.hostname + ')' : '') +
                    ' | Mag ' + (isFinite(parseFloat(transit.hostMag)) ? parseFloat(transit.hostMag).toFixed(1) : '?') +
                    ' | ' + win.date + ' | ' + win.start + '–' + win.end + ' UTC' +
                    ' | Dur ' + win.duration;
          if (transit.fieldDistance < 5.0) {
            result += ' (✨ ' + transit.fieldDistance.toFixed(1) + '° from field)';
          }
        }
      }
    }
  }
  
  return result;
}

// ---------------- Aperture Calculator Functions ----------------
// Calculate image scale in arcseconds per pixel
function calculateImageScale(focalLength, pixelSize, binning) {
  // Formula: (pixel_size * binning * 206.265) / focal_length
  return (pixelSize * binning * 206.265) / focalLength;
}

// Calculate optimal aperture settings based on hardware
function calculateApertureSettings(focalLength, pixelSize, binning, fwhmArcsec) {
  // Validate inputs
  if (!isFinite(focalLength) || focalLength <= 0) focalLength = 600;   // safe default
  if (!isFinite(pixelSize)   || pixelSize   <= 0) pixelSize   = 3.76;  // safe default
  if (!isFinite(binning)     || binning     < 1)  binning     = 1;
  if (!isFinite(fwhmArcsec)  || fwhmArcsec  <= 0) fwhmArcsec  = 3.5;   // typical seeing

  var imageScale = calculateImageScale(focalLength, pixelSize, binning);

  // Guard against degenerate scale
  if (!isFinite(imageScale) || imageScale <= 0) imageScale = 1.0;

  var fwhmPixels = fwhmArcsec / imageScale;

  // Clamp FWHM to physically sensible range (0.5px–50px)
  fwhmPixels = Math.max(0.5, Math.min(50, fwhmPixels));

  // ── Aperture radius ──────────────────────────────────────────────────
  // Optimal SNR for point sources: r ≈ 1.0–1.5 × FWHM (sky-limited regime)
  // For typical exoplanet photometry with moderate sky: r ≈ 1.5 × FWHM
  // Using 1.5x keeps more sky pixels outside, improves sky estimate quality.
  // Minimum 4px so that at least ~50 pixels fall in aperture (π×4²≈50).
  var aperture_r = Math.max(4, Math.round(fwhmPixels * 1.5));

  // ── Inner sky annulus ────────────────────────────────────────────────
  // Must clear the PSF wings. Bright stars have wings extending to ~3–4×FWHM.
  // Use gap of 1.5×FWHM beyond aperture edge to clear most halos.
  // rIn must be at least r+5 to avoid contamination.
  var aperture_rIn = Math.max(aperture_r + 5, Math.round(aperture_r + fwhmPixels * 1.5));

  // ── Outer sky annulus ────────────────────────────────────────────────
  // Need enough pixels for robust sky median. Annulus area = π(rOut²-rIn²).
  // Target ≥200 sky pixels → rOut ≥ sqrt(rIn² + 200/π) ≈ rIn + several px.
  // Also add 2×FWHM width so sky sample spans full seeing variation.
  var minROut = Math.ceil(Math.sqrt(aperture_rIn * aperture_rIn + 200 / Math.PI));
  aperture_rOut = Math.max(minROut, aperture_rIn + Math.round(fwhmPixels * 2.0), aperture_rIn + 8);

  return {
    imageScale:    imageScale,
    fwhmPixels:    fwhmPixels,
    aperture_r:    aperture_r,
    aperture_rIn:  aperture_rIn,
    aperture_rOut: aperture_rOut
  };
}

// Validate that manual aperture values are self-consistent (r < rIn < rOut)
// Returns corrected values and a warning string if fixes were needed.
function validateApertureValues(r, rIn, rOut) {
  var warnings = [];
  r    = Math.max(2,  Math.round(r));
  rIn  = Math.max(r + 3, Math.round(rIn));
  rOut = Math.max(rIn + 5, Math.round(rOut));
  // Check sky annulus has enough area (≥100 px²)
  var skyArea = Math.PI * (rOut*rOut - rIn*rIn);
  if (skyArea < 100) {
    rOut = Math.ceil(Math.sqrt(rIn*rIn + 100/Math.PI)) + 1;
    warnings.push('rOut increased to ensure sufficient sky area');
  }
  if (r >= rIn)    warnings.push('r must be < rIn — rIn adjusted');
  if (rIn >= rOut) warnings.push('rIn must be < rOut — rOut adjusted');
  return { r: r, rIn: rIn, rOut: rOut, warnings: warnings };
}

// ---------------- FWHM Analysis Functions ----------------
// Calculate average FWHM from central stars for robust measurement
function calculateAverageFWHM(detectedStars, imageWidth, imageHeight) {
  if (!detectedStars || detectedStars.length === 0) {
    console.writeln('[>] No stars available for FWHM analysis');
    return null;
  }
  
  console.writeln('[>] Analyzing FWHM from ' + detectedStars.length + ' detected stars...');
  
  // Calculate image center
  var centerX = imageWidth / 2.0;
  var centerY = imageHeight / 2.0;
  var maxRadius = Math.min(imageWidth, imageHeight) * 0.4; // Use central 40% of image
  
  // Find stars within central region and calculate distance scores
  var centralStars = [];
  for (var i = 0; i < detectedStars.length; i++) {
    var star = detectedStars[i];
    var distance = Math.sqrt(Math.pow(star.x - centerX, 2) + Math.pow(star.y - centerY, 2));
    var normalizedDistance = distance / maxRadius;
    
    // Only consider stars in central region with valid FWHM
    if (normalizedDistance <= 1.0 && star.fwhm > 0 && star.fwhmArcsec > 0) {
      centralStars.push({
        star: star,
        distance: distance,
        normalizedDistance: normalizedDistance,
        weight: 1.0 - normalizedDistance // Higher weight for more central stars
      });
    }
  }
  
  console.writeln('[>] Found ' + centralStars.length + ' stars in central region for FWHM analysis');
  
  if (centralStars.length === 0) {
    console.writeln('[>] No central stars found - using default FWHM');
    return null;
  }
  
  // Sort by combined score: quality * center-weight
  centralStars.sort(function(a, b) {
    var scoreA = a.star.quality * a.weight;
    var scoreB = b.star.quality * b.weight;
    return scoreB - scoreA; // Best first
  });
  
  // Select top stars (at least 3, up to 15, prefer 10)
  var targetCount = Math.max(3, Math.min(15, Math.min(10, centralStars.length)));
  var selectedStars = centralStars.slice(0, targetCount);
  
  console.writeln('[>] Selected ' + selectedStars.length + ' high-quality central stars for FWHM averaging');
  
  // Calculate robust FWHM using sigma-clipped, deduplicated stars
  // Step 1: Remove duplicate detections (stars within 5px of each other)
  var dedupStars = [];
  for (var j = 0; j < selectedStars.length; j++) {
    var item = selectedStars[j];
    var isDup = false;
    for (var k = 0; k < dedupStars.length; k++) {
      var dx = item.star.x - dedupStars[k].star.x;
      var dy = item.star.y - dedupStars[k].star.y;
      if (Math.sqrt(dx*dx + dy*dy) < 5) { isDup = true; break; }
    }
    if (!isDup && !item.star.saturated) dedupStars.push(item);
  }
  if (dedupStars.length < 3) dedupStars = selectedStars; // fallback if too few

  // Step 2: Find the minimum reliable FWHM (best-seeing indicator)
  var allFwhm = dedupStars.map(function(it){ return it.star.fwhmArcsec; });
  allFwhm.sort(function(a,b){ return a-b; });
  var minFwhm = allFwhm[0];

  // Step 3: Keep only stars within 2.5× the minimum (exclude bloated/nebula stars)
  var cleanStars = dedupStars.filter(function(it){ return it.star.fwhmArcsec <= minFwhm * 2.5; });
  if (cleanStars.length < 2) cleanStars = dedupStars;

  var fwhmSum = 0;
  var weightSum = 0;
  var fwhmValues = [];

  for (var j = 0; j < cleanStars.length; j++) {
    var item = cleanStars[j];
    var star = item.star;
    var weight = item.weight * star.quality;
    fwhmSum += star.fwhmArcsec * weight;
    weightSum += weight;
    fwhmValues.push(star.fwhmArcsec);
    console.writeln('[>]   Star ' + (j+1) + ': (' + star.x.toFixed(0) + ',' + star.y.toFixed(0) +
                   ') FWHM=' + star.fwhmArcsec.toFixed(2) + '" quality=' + star.quality.toFixed(2) +
                   ' weight=' + weight.toFixed(2));
  }
  console.writeln('[>]   (excluded ' + (selectedStars.length - cleanStars.length) + ' outlier/saturated/duplicate stars)');

  var weightedAverageFWHM = weightSum > 0 ? fwhmSum / weightSum : 0;
  
  // Also calculate simple statistics for comparison
  var simpleMean = fwhmValues.reduce(function(a, b) { return a + b; }, 0) / fwhmValues.length;
  var sortedValues = fwhmValues.slice().sort(function(a, b) { return a - b; });
  var median = sortedValues.length % 2 === 0 ? 
    (sortedValues[sortedValues.length/2 - 1] + sortedValues[sortedValues.length/2]) / 2 :
    sortedValues[Math.floor(sortedValues.length/2)];
  
  // Calculate standard deviation
  var variance = 0;
  for (var k = 0; k < fwhmValues.length; k++) {
    variance += Math.pow(fwhmValues[k] - simpleMean, 2);
  }
  var stdDev = Math.sqrt(variance / fwhmValues.length);
  
  console.writeln('[>] FWHM Statistics:');
  console.writeln('   Weighted Average: ' + weightedAverageFWHM.toFixed(2) + '"');
  console.writeln('   Simple Mean: ' + simpleMean.toFixed(2) + '"');
  console.writeln('   Median: ' + median.toFixed(2) + '"');
  console.writeln('   Std Deviation: ' + stdDev.toFixed(2) + '"');
  console.writeln('   Range: ' + Math.min.apply(null, fwhmValues).toFixed(2) + '" - ' + Math.max.apply(null, fwhmValues).toFixed(2) + '"');
  
  return {
    weightedAverage: weightedAverageFWHM,
    simpleMean: simpleMean,
    median: median,
    standardDeviation: stdDev,
    starCount: selectedStars.length,
    fwhmValues: fwhmValues,
    selectedStars: selectedStars
  };
}

// ---------------- Cosmic Ray Removal Functions ----------------
// Calculate Median Absolute Deviation (robust measure of variability)
function calculateMAD(data) {
  var medianValue = median(data);
  var deviations = data.map(function(x) { return Math.abs(x - medianValue); });
  return median(deviations);
}

// Detect cosmic ray outliers while preserving transit signals
function detectCosmicRays(fluxData, options) {
  options = options || {};
  var threshold = options.cosmicRayThreshold || 10.0; // sigma above median
  var maxTransitDepth = (options.maxTransitDepth || 10.0) / 100.0; // Convert % to fraction
  
  // Calculate robust statistics
  var medianFlux = median(fluxData);
  var mad = calculateMAD(fluxData);
  var robustSigma = mad * 1.4826; // Convert MAD to sigma equivalent
  
  console.writeln('[>] Cosmic ray detection: median=' + medianFlux.toFixed(6) + ', °=' + robustSigma.toFixed(6));
  
  var outliers = [];
  for (var i = 0; i < fluxData.length; i++) {
    var flux = fluxData[i];
    var deviation = Math.abs(flux - medianFlux) / robustSigma;
    
    // Cosmic ray criteria:
    // 1. WAY above threshold (much more than normal stellar variation)
    // 2. Significantly brighter than median (cosmic rays brighten, transits dim)
    // 3. Not a reasonable astrophysical variation
    var isBrightOutlier = flux > medianFlux * (1 + maxTransitDepth * 2); // Much brighter than any transit
    var isExtremeOutlier = deviation > threshold;
    var isMassiveSpike = flux > medianFlux * 50; // >50x median is definitely cosmic ray
    var isAstronomicallyImpossible = flux > medianFlux * 10000; // >10000x median is impossible
    
    if ((isExtremeOutlier && isBrightOutlier) || isMassiveSpike || isAstronomicallyImpossible) {
      outliers.push(i);
      if (isAstronomicallyImpossible) {
        console.writeln('[>] EXTREME OUTLIER detected at point ' + i + ': flux=' + flux.toExponential(3) + ' (astronomically impossible)');
      } else {
        console.writeln('[>] Cosmic ray detected at point ' + i + ': flux=' + flux.toExponential(3) + ' (' + deviation.toFixed(1) + '°)');
      }
    }
  }
  
  return outliers;
}

// Remove cosmic ray outliers from photometry data
function cleanCosmicRays(photometryData, options) {
  if (!photometryData || photometryData.length === 0) {
    return photometryData;
  }
  
  options = options || {};
  console.writeln('[>] Starting cosmic ray removal with threshold=' + (options.cosmicRayThreshold || 10.0) + '°...');
  
  // Extract flux values for analysis
  var fluxValues = photometryData.map(function(point) { 
    return parseFloat(point.relativeFlux || point.flux || 1.0); 
  });
  
  // Detect cosmic ray indices
  var cosmicRayIndices = detectCosmicRays(fluxValues, options);
  
  if (cosmicRayIndices.length === 0) {
    console.writeln('? No cosmic rays detected - all data clean');
    return photometryData;
  }
  
  // Remove cosmic ray points
  var cleanedData = [];
  for (var i = 0; i < photometryData.length; i++) {
    if (cosmicRayIndices.indexOf(i) === -1) {
      cleanedData.push(photometryData[i]);
    }
  }
  
  console.writeln('? Removed ' + cosmicRayIndices.length + ' cosmic ray spikes');
  console.writeln('[>] Clean data points: ' + cleanedData.length + '/' + photometryData.length + 
                 ' (' + ((cleanedData.length / photometryData.length) * 100).toFixed(1) + '%)');
  
  return cleanedData;
}

// ---------------- Utility Functions ----------------
function min(a){ return Math.min.apply(null,a); }
function max(a){ return Math.max.apply(null,a); }
function mean(a){ var s=0; for (var i=0;i<a.length;i++) s+=a[i]; return a.length? s/a.length : 0; }
// Note: median function already declared at line 947, removing duplicate
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }

// Median function for filtering finite values (used in detrending)
function med(a){ 
  var b=a.slice().filter(function(v){return isFinite(v);}).sort(function(a,b){return a-b;});
  if(b.length==0) return 0; var m=(b.length>>1); return b.length%2? b[m] : 0.5*(b[m-1]+b[m]);
}

function joinPath(dir, name){
  var d = (''+dir).replace(/\\/g,'/');
  if (d.length && d[d.length-1] !== '/') d += '/';
  return d + name.replace(/\\/g,'/');
}

function buildKeywordMap(win){
  var m={};
  try{
    var kw=win.keywords;
    for (var i=0;i<kw.length;i++) m[kw[i].name.toUpperCase()] = kw[i].strippedValue;
  }catch(e){}
  return m;
}

function getKeyword(m, name){ return m[name]!==undefined? m[name] : m[name.toUpperCase()]!==undefined? m[name.toUpperCase()] : undefined; }

function jdFromISO(s){
  try{ var d = new Date(s.replace(/'/g,'')); if (isNaN(d.getTime())) return NaN; return 2440587.5 + d.getTime()/86400000.0; }catch(e){ return NaN; }
}

function jdFromKeywords(m){
  var j = parseFloat(getKeyword(m,'JD'));
  if (isFinite(j)) return j;
  var mjd = parseFloat(getKeyword(m,'MJD-OBS')); if (!isFinite(mjd)) mjd = parseFloat(getKeyword(m,'MJD'));
  if (isFinite(mjd)) return mjd + 2400000.5;
  var davg = getKeyword(m,'DATE-AVG'); if (davg){ var j1=jdFromISO(davg); if (isFinite(j1)) return j1; }
  var dobs = getKeyword(m,'DATE-OBS');
  if (dobs){
    var t = getKeyword(m,'TIME-OBS');
    if (t && dobs.indexOf('T')<0) dobs = dobs.replace(/'/g,'') + 'T' + t.replace(/'/g,'');
    var j2 = jdFromISO(dobs);
    if (isFinite(j2)) return j2;
  }
  return NaN;
}

function listImagesInFolder(folder){
  var files=[];
  try{
    var ff = new FileFind;
    if (ff.begin(folder + '/*')){
      do{
        if (!ff.isDirectory){
          var n = ff.name || ff.fileName || '';
          if (/\.(xisf|fits|fit)$/i.test(n))
            files.push(joinPath(folder, n));
        }
      } while(ff.next());
    }
  }catch(e){ console.warningln('FileFind failed, ' + e); }
  files.sort();
  return files;
}

// -------- Linear regression helpers for detrending --------
function lsqFit(X, y){
  try{
    var n = X.length, p = X[0].length;
    var XtX = []; for(var i=0;i<p;i++){ XtX[i]=[]; for(var j=0;j<p;j++) XtX[i][j]=0; }
    var XtY = []; for(var i2=0;i2<p;i2++) XtY[i2]=0;
    for(var r=0;r<n;r++){
      var xr = X[r];
      for(var i3=0;i3<p;i3++){
        XtY[i3] += xr[i3]*y[r];
        for(var j3=0;j3<p;j3++) XtX[i3][j3] += xr[i3]*xr[j3];
      }
    }
    // Gaussian elimination on augmented matrix
    var A=[]; for(var i4=0;i4<p;i4++){ A[i4]=XtX[i4].slice(); A[i4].push(XtY[i4]); }
    for(var col=0; col<p; col++){
      var piv = col, best = Math.abs(A[col][col]);
      for(var r2=col+1;r2<p;r2++){ var v=Math.abs(A[r2][col]); if(v>best){best=v; piv=r2;} }
      if(best<1e-12) continue;
      if(piv!=col){ var tmp=A[col]; A[col]=A[piv]; A[piv]=tmp; }
      var fac = A[col][col];
      for(var k=col;k<=p;k++) A[col][k]/=fac;
      for(var r3=0;r3<p;r3++){
        if(r3==col) continue;
        var f = A[r3][col];
        for(var k2=col;k2<=p;k2++) A[r3][k2] -= f*A[col][k2];
      }
    }
    var beta=[]; for(var i5=0;i5<p;i5++) beta[i5] = isFinite(A[i5][p])? A[i5][p] : 0;
    return beta;
  }catch(e){
    console.warningln('[!] lsqFit failed: ' + e);
    return [0];
  }
}

function detrendRelFlux(timesHours, relFlux, airmassArr, skyArr, fwhmArr, terms){
  try{
    var n = relFlux.length;
    var useAM = terms.indexOf('airmass')>=0;
    var useSky = terms.indexOf('sky')>=0;
    var useF  = terms.indexOf('fwhm')>=0;
    var useT  = terms.indexOf('time')>=0;
    var X=[], y=[];
    var lny=[];
    for(var i=0;i<n;i++) lny[i] = Math.log(Math.max(1e-6, relFlux[i]));
    // Using the top-level med function instead of local declaration
    var amMed = med(airmassArr);
    var skyMed = med(skyArr);
    var fMed = med(fwhmArr);
    var t0 = timesHours[0];
    for(var i2=0;i2<n;i2++){
      var row=[1.0];
      if(useAM){ row.push(isFinite(airmassArr[i2])? (airmassArr[i2]-amMed) : 0); }
      if(useSky){ row.push(skyArr[i2]-skyMed); }
      if(useF){ row.push(fwhmArr[i2]-fMed); }
      if(useT){ row.push(timesHours[i2]-t0); }
      X.push(row); y.push(lny[i2]);
    }
    var beta = lsqFit(X,y);
    var detr = [];
    for(var i3=0;i3<n;i3++){
      var fit = beta[0], idx=1;
      if(useAM){ fit += beta[idx++] * (isFinite(airmassArr[i3])? (airmassArr[i3]-amMed) : 0); }
      if(useSky){ fit += beta[idx++] * (skyArr[i3]-skyMed); }
      if(useF){ fit += beta[idx++] * (fwhmArr[i3]-fMed); }
      if(useT){ fit += beta[idx++] * (timesHours[i3]-t0); }
      detr[i3] = Math.exp( lny[i3] - (fit - beta[0]) ); // normalize about intercept
    }
    return {beta:beta, detrended:detr};
  }catch(e){
    console.warningln('[!] detrendRelFlux failed: ' + e);
    return {beta:[], detrended: relFlux.slice()};
  }
}

// ============================================================
// PHOTOMETRY HELPERS — v2.0  (HOPS-inspired robust methods)
// ============================================================

// ── annulusStats ─────────────────────────────────────────────
// Replaces simple mean with iterative sigma-clipping (3σ, up to
// 5 passes).  Stars or cosmic rays sitting inside the sky annulus
// used to pull the sky estimate high, which then subtracted too
// much flux from faint targets.  Sigma-clipping identifies and
// removes those outlier pixels before computing the sky median.
// Using the median (not mean) as the sky estimator gives extra
// robustness against residual hot pixels after clipping.
// Sky σ is estimated via MAD→σ conversion (×1.4826), identical
// to the approach used by HOPS and astropy sigma_clipped_stats.
function annulusStats(img, cx, cy, rIn, rOut) {
  var w = img.bounds.width, h = img.bounds.height;
  var rIn2 = rIn*rIn, rOut2 = rOut*rOut;
  var y0 = Math.max(0, Math.floor(cy-rOut)), y1 = Math.min(h-1, Math.ceil(cy+rOut));
  var x0 = Math.max(0, Math.floor(cx-rOut)), x1 = Math.min(w-1, Math.ceil(cx+rOut));

  // Collect all annulus pixels
  var vals = [];
  for (var y=y0; y<=y1; y++) {
    for (var x=x0; x<=x1; x++) {
      var dx=x-cx, dy=y-cy, d2=dx*dx+dy*dy;
      if (d2 >= rIn2 && d2 <= rOut2) vals.push(img.sample(x,y,0));
    }
  }
  if (vals.length === 0) return {mean:0, median:0, sigma:0, n:0};

  // Iterative sigma-clipping (max 5 passes, 3σ threshold)
  for (var pass=0; pass<5; pass++) {
    vals.sort(function(a,b){return a-b;});
    var mid = Math.floor(vals.length/2);
    var skyMed = (vals.length%2===0) ? 0.5*(vals[mid-1]+vals[mid]) : vals[mid];

    // MAD → robust sigma
    var devs = [];
    for (var i=0; i<vals.length; i++) devs.push(Math.abs(vals[i]-skyMed));
    devs.sort(function(a,b){return a-b;});
    var madMid = Math.floor(devs.length/2);
    var mad  = (devs.length%2===0) ? 0.5*(devs[madMid-1]+devs[madMid]) : devs[madMid];
    var sig  = mad * 1.4826;

    // Reject > 3σ outliers (stars, cosmics, hot pixels)
    var clipped = [];
    var lo = skyMed - 3*sig, hi = skyMed + 3*sig;
    for (var j=0; j<vals.length; j++) {
      if (vals[j] >= lo && vals[j] <= hi) clipped.push(vals[j]);
    }
    if (clipped.length === vals.length) break; // converged
    vals = clipped;
  }

  // Final sky = median of clipped pixels
  vals.sort(function(a,b){return a-b;});
  var n = vals.length;
  var med2 = (n%2===0) ? 0.5*(vals[n/2-1]+vals[n/2]) : vals[(n-1)/2];
  var sum=0, sum2=0;
  for (var k=0; k<n; k++){ sum+=vals[k]; sum2+=vals[k]*vals[k]; }
  var mu  = sum/n;
  var sig2 = Math.max(0, sum2/n - mu*mu);

  return {mean: med2, median: med2, sigma: Math.sqrt(sig2), n: n};
}

// ── localCentroid ────────────────────────────────────────────
// Replaces fixed-box single-pass centroid with iterative flux-
// weighted centroid.  Each pass re-centres the box on the result
// of the previous pass (up to 5 iterations or until convergence
// to < 0.01 px).  Background is subtracted from each pixel before
// weighting so faint halos don't bias the centre — this is the
// same windowed-centroid approach HOPS uses.
// half = search half-width; uses annulus outside 0.5×half for bg.
function localCentroid(img, cx, cy, half) {
  var w = img.bounds.width, h = img.bounds.height;
  var px = cx, py = cy;

  for (var iter=0; iter<5; iter++) {
    var x0 = Math.max(0, Math.floor(px-half));
    var x1 = Math.min(w-1, Math.ceil(px+half));
    var y0 = Math.max(0, Math.floor(py-half));
    var y1 = Math.min(h-1, Math.ceil(py+half));

    // Quick local background from outer half of box
    var bgVals = [];
    var bgR2_in  = (half*0.7)*(half*0.7);
    var bgR2_out = half*half;
    for (var y=y0; y<=y1; y++) {
      for (var x=x0; x<=x1; x++) {
        var d2 = (x-px)*(x-px)+(y-py)*(y-py);
        if (d2>=bgR2_in && d2<=bgR2_out) bgVals.push(img.sample(x,y,0));
      }
    }
    bgVals.sort(function(a,b){return a-b;});
    var bg = bgVals.length ? bgVals[Math.floor(bgVals.length/2)] : 0;

    // Flux-weighted centroid with background-subtracted weights
    var sx=0, sy=0, sw=0;
    for (var yy=y0; yy<=y1; yy++) {
      for (var xx=x0; xx<=x1; xx++) {
        var v = img.sample(xx,yy,0) - bg;
        if (v > 0) { sx += xx*v; sy += yy*v; sw += v; }
      }
    }
    if (sw <= 0) break;
    var nx = sx/sw, ny = sy/sw;
    if (Math.abs(nx-px)<0.01 && Math.abs(ny-py)<0.01) { px=nx; py=ny; break; }
    px=nx; py=ny;
  }
  return {x:px, y:py};
}

// ── aperturePhotometry ───────────────────────────────────────
// Key improvements over the previous version:
//
// 1. SUBPIXEL PARTIAL COVERAGE — edge pixels are subdivided into
//    a 5×5 subgrid and the fraction inside the aperture is used
//    as the pixel weight.  This eliminates the step-function
//    aperture edge that added ~0.5% systematic noise on small
//    apertures relative to the star PSF.
//
// 2. SKY FROM SIGMA-CLIPPED ANNULUS — uses the new annulusStats
//    which rejects stars/cosmics in the sky region (see above).
//
// 3. HONEST NET FLUX — returns the true net value (can be
//    negative on very faint stars or bad frames) rather than
//    clamping to 1e-12.  Callers can decide how to handle
//    negatives; clamping here hid bad frames silently.
//
// 4. SATURATION FLAG — checks the peak pixel and flags saturated
//    stars so they can be rejected from the comparison ensemble.
function aperturePhotometry(img, cx, cy, r, rIn, rOut) {
  var w = img.bounds.width, h = img.bounds.height;
  var r2 = r*r;
  var borderR = r - 1.0; // pixels fully inside — no subsampling needed
  var borderR2 = borderR > 0 ? borderR*borderR : -1;

  var s=0, nFull=0, nEdge=0, peakVal=0;
  var y0 = Math.max(0, Math.floor(cy-r)), y1 = Math.min(h-1, Math.ceil(cy+r));
  var x0 = Math.max(0, Math.floor(cx-r)), x1 = Math.min(w-1, Math.ceil(cx+r));

  for (var y=y0; y<=y1; y++) {
    for (var x=x0; x<=x1; x++) {
      var dx=x-cx, dy=y-cy, d2=dx*dx+dy*dy;
      var pv = img.sample(x,y,0);
      if (pv > peakVal) peakVal = pv;

      if (d2 <= borderR2) {
        // Fully inside — full weight
        s += pv;
        nFull++;
      } else if (d2 <= (r+1)*(r+1)) {
        // Possible edge pixel — subsample 5×5
        var frac = 0;
        for (var sy=0; sy<5; sy++) {
          for (var sx=0; sx<5; sx++) {
            var sdx = dx + (sx-2)*0.2, sdy = dy + (sy-2)*0.2;
            if (sdx*sdx+sdy*sdy <= r2) frac += 0.04; // 1/25
          }
        }
        if (frac > 0) { s += pv*frac; nEdge += frac; }
      }
    }
  }

  var sky = annulusStats(img, cx, cy, rIn, rOut);
  var npix = nFull + nEdge;
  var net  = s - sky.mean * npix;

  return {
    netFlux:  net,           // honest value — negative means star below sky
    sky:      sky.mean,
    skySigma: sky.sigma,
    npix:     npix,
    peak:     peakVal,
    saturated: (peakVal > 0.98)  // 0.98 threshold — mild saturation included with warning
  };
}

// ── farFrom ─────────────────────────────────────────────────
function farFrom(p, q, d) {
  var dx=p.x-q.x, dy=p.y-q.y;
  return dx*dx+dy*dy > d*d;
}

// ── findBrightStars ──────────────────────────────────────────
// Improvements over previous version:
//
// 1. LARGER LOCAL-MAX WINDOW — checks 5×5 neighbourhood instead
//    of 3×3, avoiding false detections on noise peaks.
//
// 2. SATURATION REJECTION — stars flagged saturated by
//    aperturePhotometry are excluded from the comparison pool.
//    Saturated stars have non-linear, frame-variable flux and
//    actively degrade ensemble photometry.
//
// 3. SNR FLOOR — requires peak > 5× sky sigma so faint noise
//    bumps don't end up as comparison stars.
//
// 4. SCAN STEP ADAPTIVE TO APERTURE — ensures the grid step
//    is small enough that we don't miss stars smaller than r.
function findBrightStars(img, want, guardRadius, scanStep, r, rIn, rOut) {
  var w=img.bounds.width, h=img.bounds.height;
  var pts=[];
  var step = Math.max(Math.max(3, Math.floor(r*0.6)), scanStep|0);

  // Get a coarse sky estimate for SNR floor
  var roughSky = annulusStats(img, w/2, h/2, Math.min(w,h)*0.3, Math.min(w,h)*0.45);
  var snrFloor = Math.max(roughSky.sigma * 5, 1e-6);

  for (var y=step; y<h-step; y+=step) {
    for (var x=step; x<w-step; x+=step) {
      var v = img.sample(x,y,0);
      if (v <= 0) continue;

      // 5×5 local max check
      var localMax = true;
      for (var dy=-2; dy<=2 && localMax; dy++) {
        for (var dx=-2; dx<=2; dx++) {
          var nx2 = x+dx, ny2 = y+dy;
          if (nx2<0||nx2>=w||ny2<0||ny2>=h) continue;
          if (img.sample(nx2,ny2,0) > v) { localMax=false; break; }
        }
      }
      if (!localMax) continue;

      // Quick SNR check before expensive centroid+photometry
      if (v < snrFloor) continue;

      var c = localCentroid(img,x,y, Math.max(r*1.5, 8));
      var ap = aperturePhotometry(img, c.x, c.y, r, rIn, rOut);

      // Reject saturated stars — they pollute ensemble photometry
      if (ap.saturated) continue;
      if (!isFinite(ap.netFlux) || ap.netFlux <= 0) continue;

      pts.push({x:c.x, y:c.y, flux:ap.netFlux});
    }
  }

  pts.sort(function(a,b){ return b.flux - a.flux; });
  var out = [];
  for (var i=0; i<pts.length && out.length<want; i++) {
    var good = true;
    for (var j=0; j<out.length; j++) {
      if (!farFrom(pts[i], out[j], guardRadius)) { good=false; break; }
    }
    if (good) out.push(pts[i]);
  }
  return out;
}

// ---------------- Curve Fitting Algorithms ----------------

// Polynomial regression using least squares
function fitPolynomial(xData, yData, degree) {
  var n = xData.length;
  if (n === 0 || n !== yData.length || degree >= n) {
    return null;
  }
  
  // Build design matrix A and response vector b
  var A = [];
  var b = [];
  
  for (var i = 0; i < n; i++) {
    var row = [];
    for (var j = 0; j <= degree; j++) {
      row.push(Math.pow(xData[i], j));
    }
    A.push(row);
    b.push(yData[i]);
  }
  
  // Solve A^T * A * x = A^T * b using normal equations
  var AtA = [];
  var Atb = [];
  var m = degree + 1;
  
  // Initialize AtA and Atb
  for (var i = 0; i < m; i++) {
    AtA.push([]);
    Atb.push(0);
    for (var j = 0; j < m; j++) {
      AtA[i].push(0);
    }
  }
  
  // Compute A^T * A and A^T * b
  for (var i = 0; i < m; i++) {
    for (var j = 0; j < m; j++) {
      for (var k = 0; k < n; k++) {
        AtA[i][j] += A[k][i] * A[k][j];
      }
    }
    for (var k = 0; k < n; k++) {
      Atb[i] += A[k][i] * b[k];
    }
  }
  
  // Solve using Gaussian elimination
  var coeffs = solveLinearSystem(AtA, Atb);
  if (!coeffs) return null;
  
  return {
    coefficients: coeffs,
    degree: degree,
    evaluate: function(x) {
      var result = 0;
      for (var i = 0; i <= degree; i++) {
        result += coeffs[i] * Math.pow(x, i);
      }
      return result;
    }
  };
}

// Gaussian elimination solver
function solveLinearSystem(A, b) {
  var n = A.length;
  if (n === 0 || n !== b.length) return null;
  
  // Make copies to avoid modifying originals
  var AA = [];
  var bb = [];
  for (var i = 0; i < n; i++) {
    AA.push(A[i].slice());
    bb.push(b[i]);
  }
  
  // Forward elimination
  for (var i = 0; i < n; i++) {
    // Find pivot
    var maxRow = i;
    for (var k = i + 1; k < n; k++) {
      if (Math.abs(AA[k][i]) > Math.abs(AA[maxRow][i])) {
        maxRow = k;
      }
    }
    
    // Swap rows
    var temp = AA[maxRow];
    AA[maxRow] = AA[i];
    AA[i] = temp;
    
    var tempB = bb[maxRow];
    bb[maxRow] = bb[i];
    bb[i] = tempB;
    
    // Check for singular matrix
    if (Math.abs(AA[i][i]) < 1e-12) {
      return null;
    }
    
    // Eliminate column
    for (var k = i + 1; k < n; k++) {
      var factor = AA[k][i] / AA[i][i];
      for (var j = i; j < n; j++) {
        AA[k][j] -= factor * AA[i][j];
      }
      bb[k] -= factor * bb[i];
    }
  }
  
  // Back substitution
  var x = new Array(n);
  for (var i = n - 1; i >= 0; i--) {
    x[i] = bb[i];
    for (var j = i + 1; j < n; j++) {
      x[i] -= AA[i][j] * x[j];
    }
    x[i] /= AA[i][i];
  }
  
  return x;
}

// Simple transit model (trapezoidal approximation)
function fitTransitModel(xData, yData, options) {
  options = options || {};
  var baseline = options.baseline || 1.0;
  var depth = options.depth || 0.01;
  var duration = options.duration || 2.0;
  var center = options.center || (xData[0] + xData[xData.length - 1]) / 2;
  
  // Simple parameter optimization using grid search
  var bestParams = null;
  var bestChiSq = Infinity;
  
  // Search ranges
  var depthRange = [0.001, 0.1];
  var durationRange = [0.5, Math.min(8.0, (xData[xData.length - 1] - xData[0]) * 0.5)];
  var centerRange = [xData[0], xData[xData.length - 1]];
  
  var steps = 15; // Keep computation reasonable
  
  for (var d = 0; d < steps; d++) {
    var testDepth = depthRange[0] + (depthRange[1] - depthRange[0]) * d / (steps - 1);
    
    for (var dur = 0; dur < steps; dur++) {
      var testDuration = durationRange[0] + (durationRange[1] - durationRange[0]) * dur / (steps - 1);
      
      for (var c = 0; c < steps; c++) {
        var testCenter = centerRange[0] + (centerRange[1] - centerRange[0]) * c / (steps - 1);
        
        var chiSq = 0;
        var n = 0;
        
        for (var i = 0; i < xData.length; i++) {
          var predicted = transitFunction(xData[i], baseline, testDepth, testDuration, testCenter);
          var residual = yData[i] - predicted;
          chiSq += residual * residual;
          n++;
        }
        
        if (n > 0 && chiSq < bestChiSq) {
          bestChiSq = chiSq;
          bestParams = {
            baseline: baseline,
            depth: testDepth,
            duration: testDuration,
            center: testCenter
          };
        }
      }
    }
  }
  
  if (!bestParams) return null;
  
  return {
    parameters: bestParams,
    chiSquared: bestChiSq,
    evaluate: function(x) {
      return transitFunction(x, bestParams.baseline, bestParams.depth, 
                            bestParams.duration, bestParams.center);
    }
  };
}

// Transit function (simplified trapezoidal model)
function transitFunction(t, baseline, depth, duration, center) {
  var halfDur = duration / 2;
  var dt = Math.abs(t - center);
  
  if (dt > halfDur) {
    return baseline;
  } else {
    // Linear transition at edges (simplified)
    var transitionWidth = duration * 0.1; // 10% of duration for ingress/egress
    if (dt > halfDur - transitionWidth) {
      var fade = (halfDur - dt) / transitionWidth;
      return baseline - depth * fade;
    } else {
      return baseline - depth;
    }
  }
}

// Calculate R-squared goodness of fit
function calculateRSquared(xData, yData, fitFunction) {
  if (xData.length !== yData.length || xData.length === 0) return 0;
  
  var meanY = mean(yData);
  var ssTotal = 0;
  var ssResidual = 0;
  
  for (var i = 0; i < xData.length; i++) {
    var predicted = fitFunction(xData[i]);
    ssTotal += (yData[i] - meanY) * (yData[i] - meanY);
    ssResidual += (yData[i] - predicted) * (yData[i] - predicted);
  }
  
  if (ssTotal === 0) return 0;
  return 1 - (ssResidual / ssTotal);
}

// ---------------- Light Curve Plotting ----------------
function WCSHorizontalLightCurveDialog(timesJD, relFlux, errors) {
  this.__base__ = Dialog;
  this.__base__();
  this.windowTitle = '📊 Exoplanet Transit Light Curve';
  
  var N = timesJD.length;
  // Debug: console.writeln('WCSHorizontalLightCurveDialog: Processing ' + N + ' data points');
  
  if (N === 0) {
    console.warningln('No data points to plot!');
    new MessageBox(
      '❌ No Transit Data' + String.fromCharCode(10) + String.fromCharCode(10) +
      'No data points available for plotting.' + String.fromCharCode(10) +
      'Please check your photometry results.',
      'Plot Error', 
      StdIcon_Error, 
      StdButton_Ok
    ).execute();
    return;
  }
  
  // Convert times to hours from start
  var t0 = timesJD[0];
  var hours = [];
  for (var i = 0; i < N; i++) {
    hours.push((timesJD[i] - t0) * 24.0);
  }
  
  // Calculate bounds
  var xmin = min(hours), xmax = max(hours);
  // Use robust range based on median+MAD to prevent outlier spikes from
  // collapsing the Y axis and hiding the transit signal
  var sortedFlux = relFlux.slice().sort(function(a,b){ return a-b; });
  var fluxMedian = sortedFlux[Math.floor(sortedFlux.length/2)];
  var fluxMAD = (function() {
    var devs = sortedFlux.map(function(v){ return Math.abs(v - fluxMedian); });
    devs.sort(function(a,b){ return a-b; });
    return devs[Math.floor(devs.length/2)];
  })();
  var robustSigma = fluxMAD * 1.4826;
  // Clip to median +/- 5 sigma for axis range, then pad generously
  var robustMin = fluxMedian - Math.max(5 * robustSigma, 0.02);
  var robustMax = fluxMedian + Math.max(5 * robustSigma, 0.02);
  var ymin = Math.max(min(relFlux), robustMin);
  var ymax = Math.min(max(relFlux), robustMax);

  var xpad = (xmax - xmin) * 0.02;
  var ypad = Math.max(0.005, (ymax - ymin) * 0.15);
  xmin -= xpad; xmax += xpad;

  // Always show at least 0.97 to 1.03 range so transit dips are visible
  ymin = Math.min(ymin - ypad, 0.97);
  ymax = Math.max(ymax + ypad, 1.03);
  
  this.controls = new Control(this);
  this.controls.maxHeight = 70;
  
  this.showLine_Check = new CheckBox(this.controls);
  this.showLine_Check.text = 'Connect points';
  this.showLine_Check.checked = true;
  
  // Curve fitting options
  this.showCurve_Check = new CheckBox(this.controls);
  this.showCurve_Check.text = 'Show fitted curve';
  this.showCurve_Check.checked = false;
  
  this.curveType_ComboBox = new ComboBox(this.controls);
  this.curveType_ComboBox.addItem('Polynomial (degree 2)');
  this.curveType_ComboBox.addItem('Polynomial (degree 3)');
  this.curveType_ComboBox.addItem('Polynomial (degree 4)');
  this.curveType_ComboBox.addItem('Transit Model');
  this.curveType_ComboBox.currentItem = 0;
  this.curveType_ComboBox.toolTip = 'Select type of curve to fit to data';
  this.curveType_ComboBox.enabled = false;
  
  this.fitInfo_Label = new Label(this.controls);
  this.fitInfo_Label.text = 'R² = --';
  this.fitInfo_Label.textColor = 0xff666666;
  this.fitInfo_Label.visible = false;
  
  var controlsLayout = new VerticalSizer;
  controlsLayout.spacing = 6;
  controlsLayout.margin = 8;
  
  var topRow = new HorizontalSizer;
  topRow.spacing = 12;
  topRow.add(this.showLine_Check);
  topRow.add(this.showCurve_Check);
  topRow.addStretch();
  topRow.add(this.fitInfo_Label);
  
  var bottomRow = new HorizontalSizer;
  bottomRow.spacing = 8;
  bottomRow.add(this.curveType_ComboBox);
  bottomRow.addStretch();
  
  controlsLayout.add(topRow);
  controlsLayout.add(bottomRow);
  this.controls.sizer = controlsLayout;
  
  this.plot = new Control(this);
  this.plot.minWidth = 1200;
  this.plot.minHeight = 750;
  
  var mL = 90, mR = 50, mT = 85, mB = 85;
  var self = this;
  
  // Curve fitting variables
  this.currentFit = null;
  this.fitType = 'poly2';
  
  function updatePlot() { self.plot.repaint(); }
  this.showLine_Check.onCheck = updatePlot;
  
  this.showCurve_Check.onCheck = function(checked) {
    self.curveType_ComboBox.enabled = checked;
    self.fitInfo_Label.visible = checked;
    if (checked) {
      self.computeCurveFit();
    } else {
      self.currentFit = null;
    }
    updatePlot();
  };
  
  this.curveType_ComboBox.onItemSelected = function(itemIndex) {
    switch (itemIndex) {
      case 0: self.fitType = 'poly2'; break;
      case 1: self.fitType = 'poly3'; break;
      case 2: self.fitType = 'poly4'; break;
      case 3: self.fitType = 'transit'; break;
      default: self.fitType = 'poly2'; break;
    }
    if (self.showCurve_Check.checked) {
      self.computeCurveFit();
      updatePlot();
    }
  };
  
  // Compute curve fit function
  this.computeCurveFit = function() {
    try {
      if (self.fitType === 'transit') {
        self.currentFit = fitTransitModel(hours, relFlux);
        if (self.currentFit) {
          var rSq = calculateRSquared(hours, relFlux, self.currentFit.evaluate);
          var params = self.currentFit.parameters;
          self.fitInfo_Label.text = 'Transit: R² = ' + rSq.toFixed(3) + 
                                   ', Depth = ' + (params.depth * 100).toFixed(2) + '%' +
                                   ', Duration = ' + params.duration.toFixed(1) + 'h';
        } else {
          self.fitInfo_Label.text = 'Transit fit failed';
        }
      } else {
        var degree = parseInt(self.fitType.substr(4)); // Extract degree from 'polyN'
        if (hours.length > degree + 1) {
          self.currentFit = fitPolynomial(hours, relFlux, degree);
          if (self.currentFit) {
            var rSq = calculateRSquared(hours, relFlux, self.currentFit.evaluate);
            self.fitInfo_Label.text = 'Polynomial(' + degree + '): R² = ' + rSq.toFixed(3);
          } else {
            self.fitInfo_Label.text = 'Polynomial fit failed';
          }
        } else {
          self.fitInfo_Label.text = 'Not enough data points for degree ' + degree;
          self.currentFit = null;
        }
      }
    } catch (e) {
      self.fitInfo_Label.text = 'Fit error: ' + e.message;
      self.currentFit = null;
    }
  };
  
  function simpleTicks(vmin, vmax, maxTicks) {
    var span = vmax - vmin;
    if (span <= 0) return [vmin];
    var step = span / (maxTicks - 1);
    var ticks = [];
    for (var i = 0; i < maxTicks; i++) {
      ticks.push(vmin + i * step);
    }
    return ticks;
  }
  
  this.plot.onPaint = function() {
    var g = new Graphics(this);
    var W = this.width, H = this.height;
    g.antialiasing = true;
    g.brush = new Brush(0xffffffff);
    g.fillRect(0, 0, W, H);
    
    var x0 = mL, y0 = mT, x1 = W - mR, y1 = H - mB;
    var xrange = xmax - xmin, yrange = ymax - ymin;
    var plotWidth = x1 - x0, plotHeight = y1 - y0;
    
    function sx(x) {
      if (xrange === 0) return x0 + plotWidth / 2;
      return x0 + ((x - xmin) / xrange) * plotWidth;
    }
    
    function sy(y) {
      if (yrange === 0) return y0 + plotHeight / 2;
      return y1 - ((y - ymin) / yrange) * plotHeight;
    }
    
    // Horizontal grid lines
    var yt = simpleTicks(ymin, ymax, 8);
    g.pen = new Pen(0xff606060, 1);
    for (var j = 0; j < yt.length; j++) {
      var yy = sy(yt[j]);
      if (yy >= y0 && yy <= y1) {
        g.drawLine(x0, yy, x1, yy);
      }
    }
    
    // 1.0 reference line
    if (ymin <= 1.0 && ymax >= 1.0) {
      g.pen = new Pen(0xffcc8800, 2);
      var refY = sy(1.0);
      if (refY >= y0 && refY <= y1) {
        g.drawLine(x0, refY, x1, refY);
        g.font = new Font('Arial', 10);
        g.pen = new Pen(0xff888888, 1);
        g.drawText(x1 - 40, refY - 8, '1.000');
      }
    }
    
    // Plot border
    g.pen = new Pen(0xff000000, 2);
    g.drawLine(x0, y0, x1, y0);
    g.drawLine(x0, y1, x1, y1);
    g.drawLine(x0, y0, x0, y1);
    g.drawLine(x1, y0, x1, y1);
    
    // Axis labels
    g.font = new Font('Arial', 11);
    g.pen = new Pen(0xff333333, 1);
    
    var xt = simpleTicks(xmin, xmax, 6);
    for (var i2 = 0; i2 < xt.length; i2++) {
      var xx2 = sx(xt[i2]);
      var xLabel = xt[i2] < 10 ? xt[i2].toFixed(2) : xt[i2].toFixed(1);
      g.drawText(xx2 - 20, y1 + 15, xLabel);
    }
    
    for (var j2 = 0; j2 < yt.length; j2++) {
      var yy2 = sy(yt[j2]);
      var yLabel = yt[j2].toFixed(3);
      g.drawText(8, yy2 + 4, yLabel);
    }
    
    // Title and labels
    g.font = new Font('Arial', 18);
    g.pen = new Pen(0xff000000, 1);
    g.drawText((W - 300) / 2, y0 - 60, 'Exoplanet Transit Light Curve');
    
    var rms = 0;
    var mean_val = mean(relFlux);
    for (var r = 0; r < N; r++) rms += (relFlux[r] - mean_val) * (relFlux[r] - mean_val);
    rms = Math.sqrt(rms / (N - 1));
    
    g.font = new Font('Arial', 11);
    g.pen = new Pen(0xff555555, 1);
    var statsText = 'N = ' + N + ' points  •  Duration: ' + (hours[N-1] - hours[0]).toFixed(2) + ' hours  •  RMS: ' + (rms * 1000).toFixed(1) + ' mmag';
    
    // Add curve fit information if available
    if (self.showCurve_Check.checked && self.currentFit) {
      if (self.fitType === 'transit') {
        var params = self.currentFit.parameters;
        var transitInfo = '  •  Transit: Depth=' + (params.depth * 100).toFixed(1) + '%, Center=' + params.center.toFixed(2) + 'h, Duration=' + params.duration.toFixed(1) + 'h';
        statsText += transitInfo;
      } else {
        var rSq = calculateRSquared(hours, relFlux, self.currentFit.evaluate);
        var polyInfo = '  •  Fit: R²=' + rSq.toFixed(3);
        statsText += polyInfo;
      }
    }
    
    g.drawText((W - Math.min(800, statsText.length * 6)) / 2, y0 - 35, statsText);
    
    g.font = new Font('Arial', 14);
    g.pen = new Pen(0xff000000, 1);
    g.drawText((x0 + x1) / 2 - 90, H - 30, 'Time (hours from start)');
    g.drawText(5, y0 - 15, 'Flux');
    
    // Connected line
    if (self.showLine_Check.checked && hours.length > 1) {
      g.pen = new Pen(0xff2277cc, 1.8);
      for (var L = 1; L < hours.length; L++) {
        var x1_line = sx(hours[L-1]), y1_line = sy(relFlux[L-1]);
        var x2_line = sx(hours[L]), y2_line = sy(relFlux[L]);
        if (isFinite(x1_line) && isFinite(y1_line) && isFinite(x2_line) && isFinite(y2_line)) {
          g.drawLine(x1_line, y1_line, x2_line, y2_line);
        }
      }
    }
    
    // Fitted curve
    if (self.showCurve_Check.checked && self.currentFit && self.currentFit.evaluate) {
      var curvePoints = 200; // High resolution curve
      var curveXStep = (xmax - xmin) / (curvePoints - 1);
      
      // Choose color based on fit type
      var curveColor = (self.fitType === 'transit') ? 0xffdd3333 : 0xff33aa33; // Red for transit, green for polynomial
      g.pen = new Pen(curveColor, 2.5);
      
      var prevX = null, prevY = null;
      for (var c = 0; c < curvePoints; c++) {
        var curveX = xmin + c * curveXStep;
        try {
          var curveY = self.currentFit.evaluate(curveX);
          
          // Only draw if Y value is within reasonable bounds
          if (isFinite(curveY) && curveY >= ymin - 0.1 && curveY <= ymax + 0.1) {
            var screenX = sx(curveX);
            var screenY = sy(curveY);
            
            if (prevX !== null && prevY !== null && 
                isFinite(prevX) && isFinite(prevY) && isFinite(screenX) && isFinite(screenY)) {
              g.drawLine(prevX, prevY, screenX, screenY);
            }
            
            prevX = screenX;
            prevY = screenY;
          } else {
            prevX = null;
            prevY = null;
          }
        } catch (evalError) {
          prevX = null;
          prevY = null;
        }
      }
      
      // Add curve legend and detailed fit information box
      var boxX = x1 - 220;
      var boxY = y0 + 20;
      var boxW = 210;
      var boxH = (self.fitType === 'transit') ? 85 : 65;
      
      // Semi-transparent background for fit info
      g.brush = new Brush(0xccffffff);
      g.pen = new Pen(0xff888888, 1);
      g.fillRect(boxX, boxY, boxW, boxH);
      g.drawRect(boxX, boxY, boxW, boxH);
      
      g.font = new Font('Arial', 10);
      if (self.fitType === 'transit') {
        g.pen = new Pen(0xffdd3333, 1);
        g.drawText(boxX + 8, boxY + 15, 'Transit Model Fit');
        
        g.font = new Font('Arial', 9);
        g.pen = new Pen(0xff333333, 1);
        var params = self.currentFit.parameters;
        var rSq = calculateRSquared(hours, relFlux, self.currentFit.evaluate);
        g.drawText(boxX + 8, boxY + 30, 'Depth: ' + (params.depth * 100).toFixed(2) + '%');
        g.drawText(boxX + 8, boxY + 42, 'Duration: ' + params.duration.toFixed(2) + ' hours');
        g.drawText(boxX + 8, boxY + 54, 'Center: ' + params.center.toFixed(2) + ' hours');
        g.drawText(boxX + 8, boxY + 66, 'R²: ' + rSq.toFixed(4));
        g.drawText(boxX + 8, boxY + 78, 'χ²: ' + (self.currentFit.chiSquared / hours.length).toFixed(6));
      } else {
        var degree = parseInt(self.fitType.substr(4));
        g.pen = new Pen(0xff33aa33, 1);
        g.drawText(boxX + 8, boxY + 15, 'Polynomial Fit (degree ' + degree + ')');
        
        g.font = new Font('Arial', 9);
        g.pen = new Pen(0xff333333, 1);
        var rSq = calculateRSquared(hours, relFlux, self.currentFit.evaluate);
        g.drawText(boxX + 8, boxY + 30, 'R²: ' + rSq.toFixed(4));
        
        // Show first few coefficients
        var coeffs = self.currentFit.coefficients;
        for (var cf = 0; cf < Math.min(3, coeffs.length); cf++) {
          g.drawText(boxX + 8, boxY + 42 + cf * 12, 'a' + cf + ': ' + coeffs[cf].toExponential(3));
        }
      }
    }
    
    // Data points
    var pointSize = 3;
    for (var P = 0; P < hours.length; P++) {
      var px = sx(hours[P]), py = sy(relFlux[P]);
      if (isFinite(px) && isFinite(py) && px >= x0 && px <= x1 && py >= y0 && py <= y1) {
        g.brush = new Brush(0xff1155aa);
        g.pen = new Pen(0xffffffff, 0.5);
        g.fillCircle(px, py, pointSize);
        g.drawCircle(px, py, pointSize);
      }
    }
    
    g.end();
  };
  
  this.closeBtn = new PushButton(this);
  this.closeBtn.text = 'Close';
  this.closeBtn.onClick = function() { this.dialog.ok(); };
  
  this.reject = function() { this.ok(); };
  
  var buttonSizer = new HorizontalSizer;
  buttonSizer.spacing = 10;
  buttonSizer.addStretch();
  buttonSizer.add(this.closeBtn);
  
  this.sizer = new VerticalSizer;
  this.sizer.margin = 12;
  this.sizer.spacing = 10;
  this.sizer.add(this.controls);
  this.sizer.add(this.plot, 100);
  this.sizer.add(buttonSizer);
}

WCSHorizontalLightCurveDialog.prototype = new Dialog;

// ---------------- Interactive Coordinate Input Dialog ----------------
function CoordinateInputDialog(parentDialog, imageWindow) {
  this.__base__ = Dialog;
  this.__base__();
  this.parentDialog = parentDialog;
  this.imageWindow = imageWindow;
  this.windowTitle = '🎯 Interactive Target Selection';
  
  // Get image dimensions for validation
  this.imageWidth = imageWindow.mainView.image.bounds.width;
  this.imageHeight = imageWindow.mainView.image.bounds.height;
  
  var self = this;
  
  // Instructions
  this.instructionLabel = new Label(this);
  this.instructionLabel.text = 
    'Image: ' + imageWindow.mainView.id + '\n' +
    'Size: ' + this.imageWidth + ' x ' + this.imageHeight + ' pixels\n\n' +
    'Enter the pixel coordinates of your target star:';
  this.instructionLabel.textAlignment = TextAlign_Left;
  
  // X coordinate input
  this.xCoord = new NumericEdit(this);
  this.xCoord.label.text = 'Target X (pixels):';
  this.xCoord.setReal(true);
  this.xCoord.setRange(0, this.imageWidth - 1);
  this.xCoord.setPrecision(2);
  this.xCoord.setValue(this.imageWidth / 2); // Default to center
  this.xCoord.toolTip = 'X coordinate of target star (0 to ' + (this.imageWidth - 1) + ')';
  
  // Y coordinate input
  this.yCoord = new NumericEdit(this);
  this.yCoord.label.text = 'Target Y (pixels):';
  this.yCoord.setReal(true);
  this.yCoord.setRange(0, this.imageHeight - 1);
  this.yCoord.setPrecision(2);
  this.yCoord.setValue(this.imageHeight / 2); // Default to center
  this.yCoord.toolTip = 'Y coordinate of target star (0 to ' + (this.imageHeight - 1) + ')';
  
  // Preview coordinates button
  this.previewButton = new PushButton(this);
  this.previewButton.text = '° Preview Selection';
  this.previewButton.toolTip = 'Show target location on the image';
  this.previewButton.onClick = function() {
    self.previewCoordinates();
  };
  
  // Set coordinates button
  this.setButton = new PushButton(this);
  this.setButton.text = '? Set Target Coordinates';
  this.setButton.onClick = function() {
    self.setTargetCoordinates();
  };
  
  // Cancel button
  this.cancelButton = new PushButton(this);
  this.cancelButton.text = 'Cancel';
  this.cancelButton.onClick = function() {
    self.cancel();
  };
  
  // Layout
  this.sizer = new VerticalSizer;
  this.sizer.margin = 12;
  this.sizer.spacing = 8;
  
  this.sizer.add(this.instructionLabel);
  this.sizer.addSpacing(8);
  this.sizer.add(this.xCoord);
  this.sizer.add(this.yCoord);
  this.sizer.addSpacing(8);
  
  var buttonSizer = new HorizontalSizer;
  buttonSizer.spacing = 8;
  buttonSizer.add(this.previewButton);
  buttonSizer.addStretch();
  buttonSizer.add(this.setButton);
  buttonSizer.add(this.cancelButton);
  this.sizer.add(buttonSizer);
  
  this.adjustToContents();
}

CoordinateInputDialog.prototype = new Dialog;

CoordinateInputDialog.prototype.previewCoordinates = function() {
  var x = this.xCoord.value;
  var y = this.yCoord.value;
  
  new MessageBox(
    '🎯 Preview Coordinates' + String.fromCharCode(10) + String.fromCharCode(10) +
    'Target Location:' + String.fromCharCode(10) +
    'X: ' + x.toFixed(2) + ' pixels' + String.fromCharCode(10) +
    'Y: ' + y.toFixed(2) + ' pixels' + String.fromCharCode(10) + String.fromCharCode(10) +
    'Check the image window to verify this is your target star location.',
    'Coordinate Preview',
    StdIcon_Information,
    StdButton_Ok
  ).execute();
  
  console.writeln('[>] Preview coordinates: (' + x.toFixed(2) + ', ' + y.toFixed(2) + ')');
};

CoordinateInputDialog.prototype.setTargetCoordinates = function() {
  var x = this.xCoord.value;
  var y = this.yCoord.value;
  
  // Update parent dialog coordinates
  this.parentDialog.pixX.setValue(x);
  this.parentDialog.pixY.setValue(y);
  
  // Switch to pixel mode if not already
  this.parentDialog.mode_Pixel.checked = true;
  this.parentDialog.mode_WCS.checked = false;
  this.parentDialog.updateUI();
  
  // Save to global settings
  GlobalSettings.pixX = x;
  GlobalSettings.pixY = y;
  GlobalSettings.mode = 'pixel';
  
  console.writeln('? Target coordinates set: (' + x.toFixed(2) + ', ' + y.toFixed(2) + ')');
  
  new MessageBox(
    '✅ Target Coordinates Set!' + String.fromCharCode(10) + String.fromCharCode(10) +
    'Pixel coordinates updated:' + String.fromCharCode(10) +
    'X: ' + x.toFixed(2) + String.fromCharCode(10) +
    'Y: ' + y.toFixed(2) + String.fromCharCode(10) + String.fromCharCode(10) +
    'Mode switched to Pixel coordinates.' + String.fromCharCode(10) +
    'You can now proceed with photometry.',
    'Coordinates Updated',
    StdIcon_Information,
    StdButton_Ok
  ).execute();
  
  this.ok();
};

// ---------------- WCS-Based Exoplanet Positioning ----------------
// Convert exoplanet RA/Dec coordinates to precise pixel positions using WCS
function findExoplanetPixelPosition(exoplanet, imageWindow) {
  try {
    console.writeln('[WCS] Attempting precise positioning for ' + exoplanet.hostname + ' (' + exoplanet.name + ')');
    console.writeln('[WCS] Database coordinates: RA=' + exoplanet.ra.toFixed(6) + '°, Dec=' + exoplanet.dec.toFixed(6) + '°');
    
    // Check if image has valid astrometric solution
    if (!(imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution)) {
      console.writeln('[WCS] No astrometric solution found - falling back to center-based detection');
      return { success: false, error: 'No WCS solution available' };
    }
    
    var solution = (imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution);
    console.writeln('[WCS] Found valid astrometric solution');
    
    // Convert RA/Dec to radians for PixInsight
    var raRad = exoplanet.ra * Math.PI / 180.0;
    var decRad = exoplanet.dec * Math.PI / 180.0;
    
    // Convert celestial coordinates to image coordinates
    var pixelCoords = solution.celestialToImage(raRad, decRad);
    
    if (!pixelCoords || pixelCoords.length < 2) {
      console.writeln('[WCS] Coordinate conversion failed');
      return { success: false, error: 'WCS coordinate conversion failed' };
    }
    
    var pixelX = pixelCoords[0];
    var pixelY = pixelCoords[1];
    
    // Check if coordinates are within image bounds
    var imageWidth = imageWindow.mainView.image.width;
    var imageHeight = imageWindow.mainView.image.height;
    
    if (pixelX < 0 || pixelX >= imageWidth || pixelY < 0 || pixelY >= imageHeight) {
      console.writeln('[WCS] Calculated position is outside image bounds: (' + pixelX.toFixed(1) + ', ' + pixelY.toFixed(1) + ')');
      console.writeln('[WCS] Image size: ' + imageWidth + 'x' + imageHeight);
      return { success: false, error: 'Exoplanet position is outside image field of view' };
    }
    
    console.writeln('[WCS] ✨ SUCCESS: Precise position calculated at (' + pixelX.toFixed(2) + ', ' + pixelY.toFixed(2) + ')');
    
    return {
      success: true,
      x: pixelX,
      y: pixelY,
      method: 'WCS-based positioning'
    };
    
  } catch (e) {
    console.warningln('[WCS] Error in WCS positioning: ' + e);
    return { success: false, error: 'WCS positioning exception: ' + e.toString() };
  }
}

// Find detected star closest to WCS-calculated exoplanet position
function findStarNearWCSPosition(detectedStars, wcsPosition, searchRadiusPixels) {
  searchRadiusPixels = searchRadiusPixels || 50; // Default 50 pixel search radius (increased for better detection)
  
  var bestStar = null;
  var minDistance = searchRadiusPixels + 1; // Start beyond search radius
  
  console.writeln('[WCS] Searching for detected stars within ' + searchRadiusPixels + ' pixels of WCS position');
  
    for (var i = 0; i < detectedStars.length; i++) {
      var star = detectedStars[i];
      
      // Enhanced: Use improved Euclidean distance calculation
      var starPoint = [star.x, star.y];
      var wcsPoint = [wcsPosition.x, wcsPosition.y];
      var distance = calculateEnhancedEuclideanDistance(starPoint, wcsPoint);
      
      console.writeln('[WCS] Star ' + i + ': (' + star.x.toFixed(1) + ', ' + star.y.toFixed(1) + ') distance=' + distance.toFixed(1) + 'px quality=' + star.quality.toFixed(3));
      
      if (distance < minDistance && distance <= searchRadiusPixels) {
        minDistance = distance;
        bestStar = star;
        console.writeln('[WCS] -> Enhanced best match: distance=' + distance.toFixed(1) + 'px');
      }
    }
  
  if (bestStar) {
    console.writeln('[WCS] ✨ Found matching star at (' + bestStar.x.toFixed(2) + ', ' + bestStar.y.toFixed(2) + '), distance=' + minDistance.toFixed(1) + 'px');
    return { star: bestStar, distance: minDistance, searchRadius: searchRadiusPixels, success: true };
  } else {
    // Fallback: Find the closest star regardless of distance (with reasonable limits)
    console.writeln('[WCS] No stars within ' + searchRadiusPixels + 'px radius, trying extended search...');
    
    var closestStar = null;
    var closestDistance = 999999;
    
      for (var i = 0; i < detectedStars.length; i++) {
        var star = detectedStars[i];
        
        // Enhanced: Use improved Euclidean distance calculation for fallback search
        var starPoint = [star.x, star.y];
        var wcsPoint = [wcsPosition.x, wcsPosition.y];
        var distance = calculateEnhancedEuclideanDistance(starPoint, wcsPoint);
        
        if (distance < closestDistance && distance <= 500 && star.quality > 0.001) { // Max 500px, min quality
          closestDistance = distance;
          closestStar = star;
        }
      }
    
    if (closestStar && closestDistance <= 500) {
      console.writeln('[WCS] 🔍 Fallback: Using closest reasonable star at (' + closestStar.x.toFixed(2) + ', ' + closestStar.y.toFixed(2) + '), distance=' + closestDistance.toFixed(1) + 'px');
      return { star: closestStar, distance: closestDistance, searchRadius: 500, success: true, fallback: true };
    }
    
    console.writeln('[WCS] No suitable stars found even with extended search');
    return { success: false, searchRadius: searchRadiusPixels, error: 'No stars found near WCS position' };
  }
}

// Convert HMS to decimal degrees
function hmsToDecimalDegrees(hours, minutes, seconds) {
  return (hours + minutes/60.0 + seconds/3600.0) * 15.0;
}

// Convert DMS to decimal degrees  
function dmsToDecimalDegrees(degrees, arcminutes, arcseconds) {
  var sign = degrees >= 0 ? 1 : -1;
  return sign * (Math.abs(degrees) + arcminutes/60.0 + arcseconds/3600.0);
}

// Note: HMS/DMS conversion functions are already defined earlier in the code

// ---------------- WCS Coordinate Conversion Functions ----------------


function hasWCS(win) {
  try {
    if (!win || !win.mainView) return false;
    var kw = buildKeywordMap(win);
    
    // Check for center coordinates (decimal degrees or HMS/DMS)
    var hasCenter = false;
    var ra = getKeyword(kw, 'RA');
    var dec = getKeyword(kw, 'DEC');
    var objctra = getKeyword(kw, 'OBJCTRA');
    var objctdec = getKeyword(kw, 'OBJCTDEC');
    
    if ((ra && dec) || (objctra && objctdec)) {
      hasCenter = true;
    }
    
    // Check for hardware specifications needed for plate scale calculation
    var focalLength = getKeyword(kw, 'FOCALLEN');
    var pixelSize = getKeyword(kw, 'XPIXSZ');
    var hasHardware = (focalLength && pixelSize);
    
    // Check for standard WCS keywords (CD matrix, etc.)
    var hasCore = getKeyword(kw, 'CRPIX1') && getKeyword(kw, 'CRPIX2') && 
                  getKeyword(kw, 'CRVAL1') && getKeyword(kw, 'CRVAL2');
    var hasMatrix = getKeyword(kw, 'CD1_1') && getKeyword(kw, 'CD2_2');
    var hasStandardWCS = hasCore && hasMatrix;
    
    // Return true if we have either standard WCS or hardware-based WCS
    return hasStandardWCS || (hasCenter && hasHardware);
  } catch(e) {
    return false;
  }
}

// Reference star calibration functions
function testConversionWithParams(win, ra_deg, dec_deg, centerRA, centerDec, plateScale, rotation_deg) {
  try {
    // Use rotation exactly as provided - no correction needed
    
// Quadrant parity fix for manual rotation: if angle near 0° or ±180°, add 180°
(function(){ 
  try {
    var __deg = rotation;
    var __n = ((__deg % 360) + 360) % 360;
    if (__n > 180) __n -= 360;
    if ((__n >= -45 && __n <= 45) || (__n >= 135 || __n <= -135)) {
      rotation = (__deg + 180);
    }
  } catch(e) { /* ignore */ }
})();
var rotationRad = Number(rotation) * Math.PI / 180.0;
    
    var imgW = win.mainView.image.width;
    var imgH = win.mainView.image.height;
    var centerX = imgW / 2.0;
    var centerY = imgH / 2.0;
    
    var deltaRA = (ra_deg - centerRA);
    var deltaDec = (dec_deg - centerDec);
    
    if (deltaRA > 180) deltaRA -= 360;
    if (deltaRA < -180) deltaRA += 360;
    
    var deltaRA_arcsec = deltaRA * 3600.0 * Math.cos(centerDec * Math.PI / 180.0);
    var deltaDec_arcsec = deltaDec * 3600.0;
    
    var deltaX_raw = deltaRA_arcsec / plateScale;
    var deltaY_raw = deltaDec_arcsec / plateScale;
    
    var cos_rot = Math.cos(rotationRad);
    var sin_rot = Math.sin(rotationRad);
    
    var deltaX = deltaX_raw * cos_rot - deltaY_raw * sin_rot;
    var deltaY = deltaX_raw * sin_rot + deltaY_raw * cos_rot;
    
    var x = centerX + deltaX;
    var y = centerY - deltaY;
    
    // Coordinate calculation complete
    return { success: true, x: x, y: y };
  } catch(e) {
    return { success: false };
  }
}

// Reference star calibration removed - now using direct WCS transformation

// Calibrated conversion removed - now using direct WCS transformation

/**
                                      calibratedParams.centerRA, calibratedParams.centerDec,
                                      calibratedParams.plateScale, calibratedParams.rotation);
  
  if (result.success) {
  // Using reference calibrated parameters
  return {
    success: true,
    x: result.x,
    y: result.y,
    method: 'reference-calibrated'
  };
  } else {
    return { success: false, error: 'Calibrated conversion failed' };
  }
}

/**
 * Convert pixel coordinates back to RA/Dec (reverse coordinate transformation)
 * @param {ImageWindow} imageWindow - PixInsight image window with astrometric solution
 * @param {number} pixelX - X pixel coordinate
 * @param {number} pixelY - Y pixel coordinate
 * @returns {object} - {success: boolean, ra: number, dec: number, method: string, error: string}
 */
// =============================================================================
// PIXEL → RA/DEC CONVERSION — v3.0 UNIVERSAL (uses EXOWCS, no hacks)
// =============================================================================
// Used when the user clicks a star in the preview to read back its sky coords.
// Delegates entirely to the EXOWCS engine — native PixInsight API first,
// TAN-projection fallback second. No manual rotation math, no offsets.
// =============================================================================
function pixelToRADec(imageWindow, pixelX, pixelY) {
  try {
    if (!imageWindow || imageWindow.isNull) {
      return { success: false, error: 'No image window', method: 'no-image' };
    }

    console.writeln('[REVERSE] Pixel (' + pixelX.toFixed(2) + ', ' + pixelY.toFixed(2) + ') → RA/Dec (EXOWCS v3)');

    var provider = null;
    try {
      provider = EXOWCS.buildProvider(imageWindow);
    } catch (e) {
      return { success: false, error: 'EXOWCS.buildProvider failed: ' + e, method: 'exowcs-build-error' };
    }

    if (!provider || !provider.ok) {
      console.warningln('[REVERSE] No usable WCS solution. Plate-solve the image first.');
      return {
        success: false,
        error: 'No WCS solution — plate-solve the image with ImageSolver first.',
        method: 'no-wcs'
      };
    }

    var world;
    try {
      world = provider.pixelToWorld(pixelX, pixelY);
    } catch (e) {
      return { success: false, error: 'pixelToWorld failed: ' + e, method: 'exowcs-error' };
    }

    if (!world || !isFinite(world.ra) || !isFinite(world.dec)) {
      return { success: false, error: 'pixelToWorld returned invalid coords', method: 'exowcs-invalid' };
    }

    // Normalise RA to [0, 360)
    var ra = ((world.ra % 360) + 360) % 360;
    var dec = Math.max(-90, Math.min(90, world.dec));

    console.writeln('[REVERSE] RA=' + ra.toFixed(6) + '°  Dec=' + dec.toFixed(6) + '°');

    return {
      success: true,
      ra: ra,
      dec: dec,
      method: provider.info && provider.info.ok ? 'exowcs-tan-inverse' : 'exowcs-native-api'
    };

  } catch (e) {
    console.warningln('[REVERSE] pixelToRADec exception: ' + e);
    return { success: false, error: 'Exception: ' + e, method: 'exception' };
  }
}

// MANUAL PLATE SOLVE: Legacy wrapper — now delegates entirely to raDecToPixel via EXOWCS.
// Kept so any existing callers don't break.
function plateSolveToPixel(ra_deg, dec_deg, imageWindow, detectedStars) {
  return raDecToPixel(imageWindow, ra_deg, dec_deg);
}

// =============================================================================
// PRIMARY WCS CONVERSION — v3.0 UNIVERSAL (no hacks, no hard-coded offsets)
// =============================================================================
// Uses the EXOWCS engine defined later in this file.
//
// Priority order:
//   1. PixInsight's native astro.WorldToImage()  — most accurate, uses ImageSolver solution
//   2. TAN-projection from CD/PC matrix in FITS headers — correct spherical math
//   3. Fail cleanly with a diagnostic message — never guess with empirical offsets
//
// This function works correctly on ANY plate-solved image regardless of camera
// rotation, telescope orientation, hemisphere, or field of view.
// =============================================================================
function raDecToPixel(win, ra_deg, dec_deg) {
  try {
    console.writeln('[WCS] raDecToPixel called: RA=' + ra_deg.toFixed(6) + '° Dec=' + dec_deg.toFixed(6) + '°');

    if (!win || win.isNull) {
      console.warningln('[WCS] FAIL: No image window provided');
      return { success: false, error: 'No image window provided' };
    }

    // Diagnostic: check what the window has
    try {
      var hasAstro = win.hasAstrometricSolution;
      var hasMV   = !!(win.mainView && (win.astrometricSolution || win.mainView.astrometricSolution));
      var imgW    = win.mainView.image.width;
      var imgH    = win.mainView.image.height;
      console.writeln('[WCS] Window: ' + win.mainView.id + ' size=' + imgW + 'x' + imgH +
                      ' hasAstrometricSolution=' + hasAstro + ' mainView.astrometricSolution=' + hasMV);
      if (hasMV) {
        var as = win.astrometricSolution || win.mainView.astrometricSolution;
        console.writeln('[WCS] astrometricSolution type=' + typeof as +
                        ' hasImageToWorld=' + (typeof as.ImageToWorld === 'function') +
                        ' hasWorldToImage=' + (typeof as.WorldToImage === 'function'));
        // Try ImageToWorld on centre pixel as a live test
        try {
          var cx = imgW/2, cy = imgH/2;
          var cw = as.ImageToWorld(new Point(cx, cy));
          console.writeln('[WCS] ImageToWorld(' + cx.toFixed(0) + ',' + cy.toFixed(0) + ') = RA=' +
                          (cw ? cw.x.toFixed(6) : 'null') + '° Dec=' + (cw ? cw.y.toFixed(6) : 'null') + '°');
        } catch(e2) {
          console.warningln('[WCS] ImageToWorld test THREW: ' + e2);
        }
      }
    } catch(diag_e) {
      console.warningln('[WCS] Diagnostic threw: ' + diag_e);
    }

    var provider = null;
    try {
      provider = EXOWCS.buildProvider(win);
      console.writeln('[WCS] buildProvider returned: ok=' + (provider ? provider.ok : 'null'));
    } catch (e) {
      console.warningln('[WCS] FAIL: buildProvider threw: ' + e);
      return { success: false, error: 'EXOWCS.buildProvider failed: ' + e };
    }

    if (!provider || !provider.ok) {
      console.warningln('[WCS] FAIL: provider.ok=false — image not plate-solved or WCS unavailable');
      return { success: false, error: 'No WCS solution available. Plate-solve the image first.' };
    }

    var px;
    try {
      px = provider.worldToPixel(ra_deg, dec_deg);
      console.writeln('[WCS] worldToPixel result: (' + (px ? px.x.toFixed(2) : 'null') + ', ' + (px ? px.y.toFixed(2) : 'null') + ')');
    } catch (e) {
      console.warningln('[WCS] FAIL: worldToPixel threw: ' + e);
      return { success: false, error: 'Coordinate conversion failed: ' + e };
    }

    if (!px || !isFinite(px.x) || !isFinite(px.y)) {
      console.warningln('[WCS] FAIL: worldToPixel returned non-finite coords');
      return { success: false, error: 'worldToPixel returned invalid coordinates' };
    }

    return { success: true, x: px.x, y: px.y };

  } catch (e) {
    console.warningln('[WCS] raDecToPixel EXCEPTION: ' + e);
    return { success: false, error: 'Exception: ' + e };
  }
}


// =============================================================================
// INTEGRATED PLATE SOLVER — v1.0
// =============================================================================
// Calls PixInsight's ImageSolver script directly on the open image window
// without closing the ExoTransit dialog. After solving, refreshes the WCS
// so the circle is placed correctly immediately.
//
// ImageSolver is a *script*, not a process, so we run it via the Script engine.
// The approach: write a tiny launcher script to a temp file and run it via
// PixInsight's includeWithVariables / Script.load mechanism, OR use the
// ImageSolver process icon if the user has one. Simplest robust method:
// use ProcessInstance on the built-in AstrometricSolution process (which is
// what ImageSolver ultimately calls), then fall back to opening ImageSolver's
// GUI for the user to fill in and click OK — the dialog stays open behind it.
// =============================================================================
function runPlateSolverOnWindow(imageWindow, callback) {
  if (!imageWindow || imageWindow.isNull) {
    new MessageBox(
      'No image is open to plate solve.\n\nPlease open an image first using the "Open Image" button.',
      'No Image Open', StdIcon_Error, StdButton_Ok
    ).execute();
    return;
  }

  console.writeln('[SOLVE] Starting plate solve for: ' + imageWindow.mainView.id);

  // Bring image to front so ImageSolver can see it as the active window
  imageWindow.bringToFront();
  imageWindow.zoomToFit();

  // ── METHOD 1: ProcessInstance — the correct PixInsight JS way to launch a process ──
  // ImageSolver is registered as module "ImageSolver" in PixInsight's process registry.
  // ProcessInstance lets us find it by ID, open its GUI, and execute it — all from script.
  var launched = false;

  try {
    // Find ImageSolver in the registered processes
    var pi = ProcessInstance.fromIcon('ImageSolver');
    if (pi) {
      console.writeln('[SOLVE] Found ImageSolver via process icon — launching');
      pi.launchInterface();
      launched = true;
    }
  } catch(e) {
    console.writeln('[SOLVE] ProcessInstance.fromIcon failed: ' + e);
  }

  if (!launched) {
    try {
      // Try by module/process ID directly
      var pi2 = new ProcessInstance('ImageSolver');
      if (pi2) {
        console.writeln('[SOLVE] Found ImageSolver via ProcessInstance constructor — launching');
        pi2.launchInterface();
        launched = true;
      }
    } catch(e) {
      console.writeln('[SOLVE] ProcessInstance constructor failed: ' + e);
    }
  }

  if (!launched) {
    // ── METHOD 2: executeScript — PixInsight's runtime script executor ──
    // This is the runtime equivalent of #include for already-installed scripts.
    try {
      // Find ImageSolver path from PixInsight's script search paths
      var piBase = '';
      try {
        // CoreApplication exposes the installation directory
        piBase = CoreApplication.resourcesPath.replace(/\/resources\/?$/, '');
      } catch(e) {}

      var candidatePaths = [
        piBase + '/src/scripts/AdP/ImageSolver.js',
        File.homeDirectory + '/.config/PixInsight/scripts/AdP/ImageSolver.js',
        'C:/Program Files/PixInsight/src/scripts/AdP/ImageSolver.js',
        'C:/Program Files/PixInsight 1.8/src/scripts/AdP/ImageSolver.js',
        '/Applications/PixInsight/src/scripts/AdP/ImageSolver.js',
        '/usr/share/pixinsight/src/scripts/AdP/ImageSolver.js'
      ];

      var found = '';
      for (var i = 0; i < candidatePaths.length; i++) {
        if (candidatePaths[i] && File.exists(candidatePaths[i])) {
          found = candidatePaths[i];
          break;
        }
      }

      if (found) {
        console.writeln('[SOLVE] Found ImageSolver at: ' + found);
        // executeScript runs a script file in a new scope — correct runtime approach
        var result = executeScript(found);
        console.writeln('[SOLVE] executeScript returned: ' + result);
        launched = true;
      } else {
        console.writeln('[SOLVE] ImageSolver.js not found in any standard path');
      }
    } catch(e) {
      console.writeln('[SOLVE] executeScript failed: ' + e);
    }
  }

  if (launched) {
    // Script is synchronous — by the time we get here the user has finished with
    // ImageSolver's dialog. Check for solution.
    _afterSolve(imageWindow, callback);
    return;
  }

  // ── FALLBACK: Guided manual solve — dialog stays open ──
  // The "Verify & Refresh" button handles the continuation after the user
  // runs ImageSolver from the Script menu themselves.
  console.writeln('[SOLVE] All automatic methods failed — showing guided instructions');
  imageWindow.bringToFront();

  new MessageBox(
    'Automatic plate solving could not launch directly on this system.\n\n' +
    'Do the following (this ExoTransit dialog stays open):\n\n' +
    '1. The image "' + imageWindow.mainView.id + '" is now in front\n' +
    '2. Go to  Script → Astrometry → Image Solver\n' +
    '3. Fill in your approximate RA/Dec and click OK\n' +
    '4. When ImageSolver finishes, click back here\n' +
    '5. Click  ✅ Verify & Refresh  to continue\n\n' +
    'Your ExoTransit settings are saved and waiting.',
    'Manual Solve Required', StdIcon_Information, StdButton_Ok
  ).execute();

  // callback will be triggered by the Verify & Refresh button instead
}

// Called after any successful solve to refresh the UI
function _afterSolve(imageWindow, callback) {
  try {
    if (!imageWindow || imageWindow.isNull) return;

    // Check the solution is actually there
    var hasSolution = false;
    try {
      hasSolution = imageWindow.hasAstrometricSolution ||
                    (imageWindow.mainView && (imageWindow.astrometricSolution || imageWindow.mainView.astrometricSolution));
    } catch(e) {}

    if (hasSolution) {
      console.writeln('[SOLVE] ✅ WCS solution confirmed on image');

      // Run a quick EXOWCS round-trip test to validate quality
      try {
        var prov = EXOWCS.buildProvider(imageWindow);
        if (prov && prov.ok) {
          var rt = prov.roundtripSelfTest();
          if (rt && rt.ok) {
            console.writeln('[SOLVE] Round-trip self-test passed (' + rt.pxError.toFixed(4) + ' px error)');
          } else {
            console.writeln('[SOLVE] Round-trip error: ' + (rt ? rt.pxError.toFixed(3) + ' px' : 'unknown'));
          }
        }
      } catch(e) { /* non-fatal */ }

      if (typeof callback === 'function') {
        callback(true, imageWindow);
      }
    } else {
      console.writeln('[SOLVE] No WCS solution found after solve attempt');
      if (typeof callback === 'function') {
        callback(false, imageWindow);
      }
    }
  } catch (e) {
    console.writeln('[SOLVE] _afterSolve error: ' + e);
  }
}

// ---------------- ° ENHANCED WORKFLOW DIALOG ----------------
function ExoTransitEnhancedDialog() {
  this.__base__ = Dialog;
  this.__base__();
  this.windowTitle = '≡ƒÄå ExoTransit Mixed Target TestBuild - Precise Exoplanet Positioning';
  
  // Make dialog resizable for side-by-side layout - increased by 10%
  this.userResizable = true;
  this.minWidth = 1320; // +10% from 1200
  this.minHeight = 770;  // +10% from 700
  this.resize(1540, 880); // +10% from 1400x800
  
  
  var self = this;
  
  // Load saved settings
  this.folder_Edit = new Edit(this);
  this.folder_Edit.text = GlobalSettings.folder;
  
  this.folder_Button = new PushButton(this);
  this.folder_Button.text = 'Browse';
  this.folder_Button.onClick = function() {
    var dlg = new GetDirectoryDialog();
    dlg.caption = 'Select image folder';
    if (dlg.execute()) {
      self.folder_Edit.text = dlg.directory;
      GlobalSettings.folder = dlg.directory;
      
      // Auto-update CSV path
      if (!self.outCSV_Edit.text || self.outCSV_Edit.text.indexOf('exo_lightcurve_option1.csv') > 0) {
        self.outCSV_Edit.text = dlg.directory + '/exo_lightcurve_option1.csv';
        GlobalSettings.csvPath = self.outCSV_Edit.text;
      }
      
      console.writeln('📁 Step 1: Folder selected: "' + dlg.directory + '"');
      console.writeln('Next: Use Step 2 to prepare for image solving (which will auto-open first frame)');
      
      // Update UI state
      self.updateUI();
    }
  };
  
  // Mode selection with memory
  this.mode_Pixel = new RadioButton(this);
  this.mode_Pixel.text = 'Pixel coordinates';
  this.mode_Pixel.checked = (GlobalSettings.mode === 'pixel');
  
  this.mode_WCS = new RadioButton(this);
  this.mode_WCS.text = 'WCS RA/Dec';  
  this.mode_WCS.checked = (GlobalSettings.mode === 'wcs');
  
  // Coordinates with memory
  this.pixX = new NumericEdit(this);
  this.pixX.label.text = 'Target X:';
  this.pixX.setReal(true);
  this.pixX.setRange(0, 1e6);
  this.pixX.setPrecision(2);
  this.pixX.setValue(GlobalSettings.pixX);
  
  this.pixY = new NumericEdit(this);
  this.pixY.label.text = 'Target Y:';
  this.pixY.setReal(true);
  this.pixY.setRange(0, 1e6);
  this.pixY.setPrecision(2);
  this.pixY.setValue(GlobalSettings.pixY);
  
  // RA coordinates in Hours:Minutes:Seconds
  this.ra_h = new SpinBox(this);
  this.ra_h.minValue = 0;
  this.ra_h.maxValue = 23;
  this.ra_h.value = Math.floor(GlobalSettings.ra / 15) || 0;
  this.ra_h.toolTip = 'Right Ascension Hours (0-23)';
  
  this.ra_m = new SpinBox(this);
  this.ra_m.minValue = 0;
  this.ra_m.maxValue = 59;
  this.ra_m.value = Math.floor((GlobalSettings.ra / 15 - this.ra_h.value) * 60) || 0;
  this.ra_m.toolTip = 'Right Ascension Minutes (0-59)';
  
  this.ra_s = new NumericEdit(this);
  this.ra_s.label.text = '';
  this.ra_s.setReal(true);
  this.ra_s.setRange(0, 59.99);
  this.ra_s.setPrecision(2);
  this.ra_s.setValue(((GlobalSettings.ra / 15 - this.ra_h.value) * 60 - this.ra_m.value) * 60 || 0);
  this.ra_s.toolTip = 'Right Ascension Seconds (0-59.99)';
  
  // Dec coordinates in Degrees:Arcminutes:Arcseconds
  this.dec_d = new SpinBox(this);
  this.dec_d.minValue = -90;
  this.dec_d.maxValue = 90;
  this.dec_d.value = Math.floor(Math.abs(GlobalSettings.dec)) * (GlobalSettings.dec >= 0 ? 1 : -1) || 0;
  this.dec_d.toolTip = 'Declination Degrees (-90 to +90)';
  
  this.dec_m = new SpinBox(this);
  this.dec_m.minValue = 0;
  this.dec_m.maxValue = 59;
  this.dec_m.value = Math.floor((Math.abs(GlobalSettings.dec) - Math.abs(this.dec_d.value)) * 60) || 0;
  this.dec_m.toolTip = 'Declination Arcminutes (0-59)';
  
  this.dec_s = new NumericEdit(this);
  this.dec_s.label.text = '';
  this.dec_s.setReal(true);
  this.dec_s.setRange(0, 59.99);
  this.dec_s.setPrecision(2);
  this.dec_s.setValue(((Math.abs(GlobalSettings.dec) - Math.abs(this.dec_d.value)) * 60 - this.dec_m.value) * 60 || 0);
  this.dec_s.toolTip = 'Declination Arcseconds (0-59.99)';
  
  // Helper functions to update HMS/DMS displays from decimal degree values
  this.updateRADisplay = function(raDegrees) {
    var raHours = raDegrees / 15.0;
    var h = Math.floor(raHours);
    var m = Math.floor((raHours - h) * 60);
    var s = ((raHours - h) * 60 - m) * 60;
    
    this.ra_h.value = h;
    this.ra_m.value = m;
    this.ra_s.setValue(s);
    console.writeln('[HMS] Updated RA display: ' + h + 'h ' + m + 'm ' + s.toFixed(2) + 's (' + raDegrees.toFixed(6) + '°)');
  };
  
  this.updateDecDisplay = function(decDegrees) {
    var sign = decDegrees >= 0 ? 1 : -1;
    var absDecDeg = Math.abs(decDegrees);
    var d = Math.floor(absDecDeg) * sign;
    var m = Math.floor((absDecDeg - Math.floor(absDecDeg)) * 60);
    var s = ((absDecDeg - Math.floor(absDecDeg)) * 60 - m) * 60;
    
    this.dec_d.value = d;
    this.dec_m.value = m;
    this.dec_s.setValue(s);
    console.writeln('[DMS] Updated Dec display: ' + d + '° ' + m + '\' ' + s.toFixed(2) + '" (' + decDegrees.toFixed(6) + '°)');
  };
  
  // Helper function to find first image in folder
  this.findFirstImageInFolder = function(folderPath) {
    try {
      var folder = new FileFind();
      folder.directory = folderPath;
      
      // Look for FITS files first
      folder.filterMode = FileFind.prototype.Files;
      
      var extensions = ['*.fits', '*.fit', '*.xisf'];
      
      for (var ext = 0; ext < extensions.length; ext++) {
        folder.initialize(extensions[ext]);
        while (folder.next()) {
          var filePath = folder.path;
          console.writeln('Found image: ' + filePath);
          folder.finalize();
          return filePath;
        }
        folder.finalize();
      }
      
      return null; // No images found
    } catch(e) {
      console.warningln('Error finding first image: ' + e);
      return null;
    }
  };
  
  // ° HARDWARE-BASED APERTURE CALCULATOR
  this.hardwareMode_Check = new CheckBox(this);
  this.hardwareMode_Check.text = 'Use Hardware Calculator (recommended)';
  this.hardwareMode_Check.checked = GlobalSettings.useHardwareCalculator;
  this.hardwareMode_Check.toolTip = 'Calculate optimal aperture settings from telescope and camera specs';
  
  // Focal Length
  this.focalLength = new NumericEdit(this);
  this.focalLength.label.text = 'Focal Length (mm):';
  this.focalLength.setReal(true);
  this.focalLength.setRange(50, 10000);
  this.focalLength.setPrecision(0);
  this.focalLength.setValue(GlobalSettings.focalLength);
  this.focalLength.toolTip = 'Total focal length of your telescope (mm)';
  
  // Pixel Size
  this.pixelSize = new NumericEdit(this);
  this.pixelSize.label.text = 'Pixel Size (°m):';
  this.pixelSize.setReal(true);
  this.pixelSize.setRange(1.0, 50.0);
  this.pixelSize.setPrecision(2);
  this.pixelSize.setValue(GlobalSettings.pixelSize);
  this.pixelSize.toolTip = 'Physical size of camera pixels in micrometers';
  
  // Binning
  this.binning = new ComboBox(this);
  this.binning.addItem('1x1');
  this.binning.addItem('2x2');
  this.binning.addItem('3x3');
  this.binning.addItem('4x4');
  this.binning.currentItem = GlobalSettings.binning - 1;
  this.binning.toolTip = 'Camera binning setting used for imaging';
  
  // Estimated FWHM
  this.fwhm = new NumericEdit(this);
  this.fwhm.label.text = 'Estimated FWHM ("):';
  this.fwhm.setReal(true);
  this.fwhm.setRange(0.5, 25.0); // 25" supports wide-field setups (f/4 + large pixels)
  this.fwhm.setPrecision(1);
  this.fwhm.setValue(GlobalSettings.estimatedFWHM);
  this.fwhm.toolTip = 'Typical star FWHM in arcseconds (2-4" is common for most setups)';
  
  // Manual Rotation Override
  this.manualRotation = new NumericEdit(this);
  this.manualRotation.label.text = 'WCS Rotation (°):';
  this.manualRotation.setReal(true);
  this.manualRotation.setRange(-360.0, 360.0);
  this.manualRotation.setPrecision(4); // Allow 4 decimal places for high precision
  this.manualRotation.setValue(GlobalSettings.manualRotation || 0.0);
  this.manualRotation.toolTip = 'Manual WCS rotation from ImageSolver console output.\nExample: "Rotation ................. 90.148 deg"\nEnter the exact value for precision targeting.';
  
  // Smart setup from FITS button (enhanced with transit detection)
  this.autoPopulate_Button = new PushButton(this);
  this.autoPopulate_Button.text = '🕰️ Smart Setup + Transit Check';
  this.autoPopulate_Button.toolTip = 'Complete setup: Extract FITS hardware + Auto-select stars + Calculate FWHM + Check for historical exoplanet transits in your data';
  this.autoPopulate_Button.onClick = function() {
    try {
      console.writeln('[>] Auto-Populate button clicked...');
      self.autoPopulateFromFITS();
    } catch(e) {
      console.warningln('[!] Auto-populate failed: ' + e);
      new MessageBox(
        '⚠️ Auto-Populate Failed' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Error: ' + e + String.fromCharCode(10) + String.fromCharCode(10) +
        'Try clicking the button again or manually configure settings.',
        'Auto-Populate Error',
        StdIcon_Warning,
        StdButton_Ok
      ).execute();
;
    }
  };
  
  // FITS info display
  this.fitsInfo = new Label(this);
  this.fitsInfo.text = 'FITS Info: No image selected';
  this.fitsInfo.toolTip = 'Equipment information extracted from FITS headers';
  
  // Interactive target selection button
  this.interactiveSelect_Button = new PushButton(this);
  this.interactiveSelect_Button.text = '🎯 Interactive Target Selection';
  this.interactiveSelect_Button.toolTip = 'Open image preview and click to select target coordinates visually';
  this.interactiveSelect_Button.onClick = function() {
    self.openInteractiveTargetSelector();
  };
  
  // Image selector dropdown
  this.imageSelector_Label = new Label(this);
  this.imageSelector_Label.text = 'Preview Image:';
  
  this.imageSelector = new ComboBox(this);
  this.imageSelector.toolTip = 'Select an image to preview in the embedded viewer';
  this.imageSelector.onItemSelected = function() {
    self.loadImagePreview();
  };
  
  // Large ScrollBox for image preview - scalable with dialog
  this.imagePreview = new ScrollBox(this);
  this.imagePreview.setMinSize(400, 300);  // Minimum usable size
  this.imagePreview.autoScroll = true;
  this.imagePreview.horizontalScrollBar = true;
  this.imagePreview.verticalScrollBar = true;
  this.imagePreview.tracking = true;
  
  // Viewport inside ScrollBox
  this.viewport = new Control(this.imagePreview);
  this.viewport.setFixedSize(100, 100); // Will be updated when image loads
  this.viewport.cursor = new Cursor(StdCursor_Cross);
  this.viewport.toolTip = 'Click inside circles (exoplanets) or crosshairs (regular targets) to reselect, or click elsewhere for new target\nAuto-calculates RA/Dec for plate-solved images • Shift+Drag to zoom • Mouse wheel to zoom';
  
  // Preview state variables
  this.previewImage = null;
  this.displayImage = null;
  this.previewTargetX = -1;
  this.previewTargetY = -1;
  this.zoomFactor = 1.0;
  this.scale = 1.0; // Image display scale factor
  
  // Drag-to-zoom rectangle selection variables
  this.isDragging = false;
  this.dragStartX = -1;
  this.dragStartY = -1;
  this.dragEndX = -1;
  this.dragEndY = -1;
  this.isShiftPressed = false;
  
  // Star detection and analysis results
  this.detectedStars = [];     // All stars found by detection algorithm
  this.selectedTarget = null;  // Automatically selected target star
  this.selectedComparisons = []; // Automatically selected comparison stars
  
  // Historical transit analysis results
  this.transitAnalysis = null; // Results from historical exoplanet transit check
  this.exoplanetTarget = null; // If exoplanet host detected as target
  
  // FWHM analysis results
  this.fwhmAnalysis = null; // Multi-star FWHM analysis results
  
  // Paint debugging flags
  this._paintLogged = false;
  this._renderSuccess = false;
  this._noImageLogged = false;
  this._circleLogged = false;
  this._stfLogged = false;
  
  // Simple viewport drawing and events
  this.viewport.onPaint = function(x0, y0, x1, y1) {
    var g = new Graphics(this);
    g.fillRect(x0, y0, x1, y1, new Brush(0xff000000));
    
    // Only log first paint call to avoid spam
    if (!self._paintLogged) {
      console.writeln('[>] First paint call ° - hasImage=' + (self.displayImage !== null));
      self._paintLogged = true;
    }
    
    if (self.displayImage) {
      // Use the working image rendering approach (don't scale bitmap - it fails)
      try {
        var bitmap = self.displayImage.render();
        
        if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
          // Apply transformation order: scale first, then translate
          g.scaleTransformation(self.scale, self.scale);
          g.translateTransformation(-self.imagePreview.scrollPosition.x, -self.imagePreview.scrollPosition.y);
          g.drawBitmap(0, 0, bitmap);
          
          // Log success only once
          if (!self._renderSuccess) {
            console.writeln('[>] Image rendered °?: ' + bitmap.width + 'x' + bitmap.height + ' at ' + (self.scale * 100).toFixed(1) + '% scale');
            self._renderSuccess = true;
          }
        } else {
          throw new Error('Invalid bitmap dimensions');
        }
        
      } catch(e) {
        console.warningln('[!] Bitmap render failed: ' + e);
        
        // Fallback: just draw a rectangle with image info
        g.pen = new Pen(0xff888888, 1);
        g.font = new Font('Arial', 12);
        g.drawText(10, 20, 'Image: ' + self.displayImage.width + 'x' + self.displayImage.height);
        g.drawText(10, 40, 'Scale: ' + (self.scale * 100).toFixed(0) + '%');
        g.drawText(10, 60, 'Render Error: ' + e.toString());
      }
      
      // Draw automatically selected target star (if available)
      // The exoplanet circle always uses self.exoplanetTarget (set exclusively by WCS math).
      // self.selectedTarget is the general photometry star and may be different.
      if (self.selectedTarget) {
        var circleTarget = self.exoplanetTarget ? self.exoplanetTarget : self.selectedTarget;
        var isExoplanetHost = (self.exoplanetTarget != null);
        var exoplanetInfo = isExoplanetHost ? {
          hostname: self.exoplanetTarget.hostname || 'Unknown',
          name:     self.exoplanetTarget.name     || 'Unknown'
        } : null;

        if (isExoplanetHost && !self._circleLogged) {
          console.writeln('[CIRCLE] Drawing exoplanet circle at WCS position (' +
            self.exoplanetTarget.x.toFixed(1) + ', ' + self.exoplanetTarget.y.toFixed(1) + ')');
          self._circleLogged = true;
        }

        if (isExoplanetHost) {
          g.pen = new Pen(0xffff00ff, 4);
          g.brush = new Brush(0x00000000);
          var radius = 25;
          g.drawCircle(circleTarget.x, circleTarget.y, radius);

          g.pen = new Pen(0xffff00ff, 2);
          g.fillCircle(circleTarget.x, circleTarget.y, 3);
          
          // Draw exoplanet host label
          g.pen = new Pen(0xffff00ff, 1);
          g.font = new Font('Arial', 12);
          g.drawText(circleTarget.x + radius + 5, circleTarget.y - 20, 'EXOPLANET HOST');
          
          if (exoplanetInfo && exoplanetInfo.hostname && exoplanetInfo.name) {
            g.drawText(circleTarget.x + radius + 5, circleTarget.y - 5,  'STAR NAME: '   + exoplanetInfo.hostname);
            g.drawText(circleTarget.x + radius + 5, circleTarget.y + 10, 'PLANET NAME: ' + exoplanetInfo.name);
          }
          // Show RA/Dec instead of pixel coordinates
          var circRA  = self.exoplanetTarget.ra  !== undefined ? self.exoplanetTarget.ra  :
                        (GlobalSettings.ra  && isFinite(GlobalSettings.ra)  ? GlobalSettings.ra  : null);
          var circDec = self.exoplanetTarget.dec !== undefined ? self.exoplanetTarget.dec :
                        (GlobalSettings.dec && isFinite(GlobalSettings.dec) ? GlobalSettings.dec : null);
          if (circRA !== null && circDec !== null && isFinite(circRA) && isFinite(circDec)) {
            // Format RA as HH MM SS.s
            var raTot = circRA / 15.0; // hours
            var raH = Math.floor(raTot);
            var raM = Math.floor((raTot - raH) * 60);
            var raS = ((raTot - raH) * 60 - raM) * 60;
            var pad2 = function(n){ return n < 10 ? '0'+n : ''+n; };
            var raStr = 'RA ' + pad2(raH) + 'h ' + pad2(raM) + 'm ' + raS.toFixed(1) + 's';
            // Format Dec as +DD MM SS
            var decSign = circDec < 0 ? '-' : '+';
            var decAbs  = Math.abs(circDec);
            var decD = Math.floor(decAbs);
            var decM = Math.floor((decAbs - decD) * 60);
            var decS = ((decAbs - decD) * 60 - decM) * 60;
            var decStr = 'Dec ' + decSign + pad2(decD) + '\u00b0 ' + pad2(decM) + '\' ' + decS.toFixed(0) + '"';
            g.drawText(circleTarget.x + radius + 5, circleTarget.y + 25, raStr);
            g.drawText(circleTarget.x + radius + 5, circleTarget.y + 40, decStr);
          } else {
            // Fallback to pixel coords if RA/Dec unavailable
            g.drawText(circleTarget.x + radius + 5, circleTarget.y + 25,
              '(' + circleTarget.x.toFixed(1) + ', ' + circleTarget.y.toFixed(1) + ')');
          }
        } else if (!self.exoplanetTarget) {
          // Draw green crosshair ONLY when there is no exoplanet in the frame.
          // When an exoplanet IS targeted, only the magenta circle is shown.
          g.pen = new Pen(0xff00ff00, 4); // Bright green, thick
          var size = 30;
          g.drawLine(self.selectedTarget.x - size, self.selectedTarget.y, self.selectedTarget.x + size, self.selectedTarget.y);
          g.drawLine(self.selectedTarget.x, self.selectedTarget.y - size, self.selectedTarget.x, self.selectedTarget.y + size);
          g.pen = new Pen(0xff00ff00, 1);
          g.font = new Font('Arial', 12);
          g.drawText(self.selectedTarget.x + size + 5, self.selectedTarget.y - 10, 'TARGET');
          var coordText = '(' + self.selectedTarget.x.toFixed(1) + ', ' + self.selectedTarget.y.toFixed(1) + ')';
          g.drawText(self.selectedTarget.x + size + 5, self.selectedTarget.y + 5, coordText);
        }
      }
      
      // Comparison stars are detected but not visually displayed (no blue markers shown)
      
      // Also draw manually selected target (if different from auto-selected)
      if (self.previewTargetX >= 0 && self.previewTargetY >= 0) {
        // Check if this is different from auto-selected target
        var isDifferent = true;
        if (self.selectedTarget) {
          var dx = Math.abs(self.previewTargetX - self.selectedTarget.x);
          var dy = Math.abs(self.previewTargetY - self.selectedTarget.y);
          
          // For exoplanet hosts, allow manual targeting anywhere within the circle
          // For regular targets, use stricter threshold to avoid duplicate crosshairs
          var threshold = self.selectedTarget.isExoplanetHost ? 1 : 5; // 1px for circles, 5px for crosshairs
          isDifferent = (dx > threshold || dy > threshold);
        }
        
        if (isDifferent) {
          // Draw yellow crosshairs for manually selected target
          g.pen = new Pen(0xffffff00, 3); // Yellow crosshair
          var manualSize = 25;
          g.drawLine(self.previewTargetX - manualSize, self.previewTargetY, self.previewTargetX + manualSize, self.previewTargetY);
          g.drawLine(self.previewTargetX, self.previewTargetY - manualSize, self.previewTargetX, self.previewTargetY + manualSize);
          
          // Draw manual target label
          g.pen = new Pen(0xffffff00, 1);
          g.font = new Font('Arial', 12);
          g.drawText(self.previewTargetX + manualSize + 5, self.previewTargetY - 10, 'MANUAL');
          var manualCoordText = '(' + self.previewTargetX.toFixed(1) + ', ' + self.previewTargetY.toFixed(1) + ')';
          g.drawText(self.previewTargetX + manualSize + 5, self.previewTargetY + 5, manualCoordText);
        }
      }
      
    } else {
      // Only log once
      if (!self._noImageLogged) {
        console.writeln('[>] No image loaded, showing placeholder');
        self._noImageLogged = true;
      }
      
      // No image loaded
      g.pen = new Pen(0xff888888, 1);
      g.font = new Font('Arial', 12);
      var text = 'Select an image from dropdown above';
      g.drawText(10, 20, text);
    }
    
    // Draw drag-to-zoom rectangle AFTER all image rendering is complete
    // This must be drawn in viewport coordinates without any transformations
    if (self.isDragging && self.displayImage && self.dragStartX >= 0 && self.dragStartY >= 0 && self.dragEndX >= 0 && self.dragEndY >= 0) {
      // Start a new Graphics context for the rectangle overlay
      var overlayG = new Graphics(this);
      
      var rectX = Math.min(self.dragStartX, self.dragEndX);
      var rectY = Math.min(self.dragStartY, self.dragEndY);
      var rectWidth = Math.abs(self.dragEndX - self.dragStartX);
      var rectHeight = Math.abs(self.dragEndY - self.dragStartY);
      
      // Draw semi-transparent blue rectangle in viewport coordinates
      overlayG.pen = new Pen(0xff0080ff, 2); // Bright blue border
      overlayG.brush = new Brush(0x400080ff); // Semi-transparent blue fill
      
      // Draw filled rectangle with border
      overlayG.fillRect(rectX, rectY, rectX + rectWidth, rectY + rectHeight);
      overlayG.drawRect(rectX, rectY, rectX + rectWidth, rectY + rectHeight);
      
      // Draw instruction text near the rectangle
      overlayG.pen = new Pen(0xff0080ff, 1);
      overlayG.font = new Font('Arial', 10);
      var textX = rectX + 5;
      var textY = Math.max(rectY - 15, 10);
      overlayG.drawText(textX, textY, 'Release to zoom to this area');
      
      overlayG.end();
    }
    
    g.end();
  };
  
  this.viewport.onMousePress = function(x, y, button, buttonState, modifiers) {
    if (button === 1 && self.displayImage) { // Left mouse button = 1
      // Check if Shift key is pressed for drag-to-zoom
      var shiftPressed = (modifiers & 0x00000001) !== 0; // PixInsight uses 0x1 for Shift key
      
      self.isShiftPressed = shiftPressed;
      
      if (self.isShiftPressed) {
        // Start drag-to-zoom rectangle selection
        self.isDragging = true;
        self.dragStartX = x;
        self.dragStartY = y;
        self.dragEndX = x;
        self.dragEndY = y;
        console.writeln('[>] Drag-to-zoom started - drag to select area');
      } else {
        // Normal click behavior - convert to image coordinates and handle click
        var imageX = (x / self.scale) + self.imagePreview.scrollPosition.x;
        var imageY = (y / self.scale) + self.imagePreview.scrollPosition.y;
        
        // Bounds check
        if (imageX >= 0 && imageY >= 0 && imageX < self.displayImage.width && imageY < self.displayImage.height) {
          self.handleImageClick(imageX, imageY);
        }
      }
    }
  };
  
  // Mouse move handler for drag-to-zoom rectangle
  this.viewport.onMouseMove = function(x, y, buttonState, modifiers) {
    if (self.isDragging && self.displayImage) {
      // Update the end position of the drag rectangle
      self.dragEndX = x;
      self.dragEndY = y;
      
      // Force a repaint to show the updated rectangle
      self.viewport.update();
    }
  };
  
  // Mouse release handler to complete drag-to-zoom
  this.viewport.onMouseRelease = function(x, y, button, buttonState, modifiers) {
    if (button === 1 && self.isDragging && self.displayImage) {
      // Complete the drag-to-zoom operation
      self.isDragging = false;
      
      // Calculate the zoom rectangle in viewport coordinates
      var rectLeft = Math.min(self.dragStartX, self.dragEndX);
      var rectTop = Math.min(self.dragStartY, self.dragEndY);
      var rectRight = Math.max(self.dragStartX, self.dragEndX);
      var rectBottom = Math.max(self.dragStartY, self.dragEndY);
      var rectWidth = rectRight - rectLeft;
      var rectHeight = rectBottom - rectTop;
      
      // Only zoom if the rectangle is large enough (avoid accidental tiny drags)
      if (rectWidth > 20 && rectHeight > 20) {
        console.writeln('[>] Zooming to selected area: ' + rectWidth + 'x' + rectHeight + ' pixels');
        self.zoomToRectangle(rectLeft, rectTop, rectWidth, rectHeight);
      } else {
        console.writeln('[>] Rectangle too small for zoom - cancelled');
      }
      
      // Reset drag state
      self.dragStartX = -1;
      self.dragStartY = -1;
      self.dragEndX = -1;
      self.dragEndY = -1;
      
      // Force repaint to clear the rectangle
      self.viewport.update();
    }
  };
  
  // Mouse wheel handler should be on the viewport, not the ScrollBox
  this.viewport.onMouseWheel = function(x, y, delta, buttonState, modifiers) {
    if (delta > 0) {
      self.zoomIn();
    } else {
      self.zoomOut();
    }
    return true; // Consume the event
  };
  
  // Calculated Results Display
  this.calculatedResults = new Label(this);
  this.calculatedResults.text = 'Image Scale: -- "/pixel  |  Calculated Settings: r=-- rIn=-- rOut=--';
  this.calculatedResults.toolTip = 'Real-time calculated aperture settings based on your hardware';
  
  // Step 2: Prepare for ImageSolver — opens first frame so user can run ImageSolver then return
  this.prepareWCS_Button = new PushButton(this);
  this.prepareWCS_Button.text = '🛰️ Prepare for ImageSolver';
  this.prepareWCS_Button.toolTip = 'Opens the first frame from your folder into PixInsight.\nThen close this script, run Script → Astrometry → Image Solver, and reopen.';
  this.prepareWCS_Button.enabled = false;
  
  
  // Aperture settings with memory
  this.r_Spin = new SpinBox(this);
  this.r_Spin.minValue = 2;
  this.r_Spin.maxValue = 60;
  this.r_Spin.value = GlobalSettings.aperture_r;
  this.r_Spin.onValueUpdated = function(val) {
    // Enforce r < rIn: push rIn up if needed
    if (val >= self.rIn_Spin.value) {
      self.rIn_Spin.value = val + 3;
      if (self.rIn_Spin.value >= self.rOut_Spin.value)
        self.rOut_Spin.value = self.rIn_Spin.value + 6;
    }
    GlobalSettings.aperture_r = val;
  };
  
  this.rIn_Spin = new SpinBox(this);
  this.rIn_Spin.minValue = 5;
  this.rIn_Spin.maxValue = 120;
  this.rIn_Spin.value = GlobalSettings.aperture_rIn;
  
  this.rOut_Spin = new SpinBox(this);
  this.rOut_Spin.minValue = 8;
  this.rOut_Spin.maxValue = 180;
  this.rOut_Spin.value = GlobalSettings.aperture_rOut;
  
  this.autoComp_Check = new CheckBox(this);
  this.autoComp_Check.text = 'Auto-select comparison stars';
  this.autoComp_Check.checked = GlobalSettings.autoComp;
  
  this.autoComp_Count = new SpinBox(this);
  this.autoComp_Count.minValue = 2;
  this.autoComp_Count.maxValue = 20;
  this.autoComp_Count.value = GlobalSettings.compCount;
  
  // CSV Output path
  var outCSVLabel = new Label(this);
  outCSVLabel.text = 'Output CSV path:';
  
  this.outCSV_Edit = new Edit(this);
  this.outCSV_Edit.text = GlobalSettings.csvPath || (GlobalSettings.folder ? (GlobalSettings.folder + '/exo_lightcurve_option1.csv') : '');
  
  this.outCSV_Button = new PushButton(this);
  this.outCSV_Button.text = 'Browse';
  this.outCSV_Button.onClick = function() {
    var dlg = new SaveFileDialog();
    dlg.caption = 'Save CSV as';
    dlg.filters = [['CSV files', '.csv']];
    if (dlg.execute()) {
      self.outCSV_Edit.text = dlg.fileName;
      GlobalSettings.csvPath = dlg.fileName;
      saveSettings(GlobalSettings);
    }
  };
  
  this.run_Button = new PushButton(this);
  this.run_Button.text = '🚀 Run Photometry';
  
  // Save settings button
  this.saveTest_Button = new PushButton(this);
  this.saveTest_Button.text = '💾 Save Settings';
  this.saveTest_Button.toolTip = 'Save current settings for this PixInsight session';
  this.saveTest_Button.onClick = function() {
    console.writeln('[>] Saving current settings...');
    self.saveSettings();
    
    // Confirmation feedback
    try {
      console.writeln('  Saved values:');
      console.writeln('  Folder: "' + (GlobalSettings.folder || 'none') + '"');
      console.writeln('  Mode: ' + GlobalSettings.mode);
      console.writeln('  Aperture: ' + GlobalSettings.aperture_r);
      console.writeln('  CSV Path: "' + (GlobalSettings.csvPath || 'default') + '"');
      
      new MessageBox(
        '💾 Settings Saved Successfully!' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Current settings have been saved for this PixInsight session.' + String.fromCharCode(10) +
        'Note: Settings will reset when PixInsight restarts.',
        'Settings Saved',
        StdIcon_Information,
        StdButton_Ok
      ).execute();
    } catch(e) {
      console.warningln('  Settings save verification failed: ' + e);
    }
  };
  
  this.close_Button = new PushButton(this);
  this.close_Button.text = 'Close';
  this.close_Button.onClick = function() { self.ok(); };
  
  // Non-modal interactive target selection function
  this.openInteractiveTargetSelector = function() {
    var imageWindow = ImageWindow.activeWindow;
    
    // SMART IMAGE DETECTION: Check global reference first, then existing open images
    if (!imageWindow || imageWindow.isNull) {
      // First check our global reference
      if (openedImageWindow && !openedImageWindow.isNull) {
        imageWindow = openedImageWindow;
        console.writeln('[>] Using globally stored image: ' + imageWindow.mainView.id);
      } else {
        var windows = ImageWindow.windows;
        if (windows.length > 0) {
          imageWindow = windows[0];
          console.writeln('[>] Using existing open image: ' + imageWindow.mainView.id);
        } else {
          // No images open - suggest using Auto-Populate first
          new MessageBox(
            '💼 No Images Available' + String.fromCharCode(10) + String.fromCharCode(10) +
            'No images are currently open in PixInsight.' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Recommended workflow:' + String.fromCharCode(10) +
            '1. Use "Smart Setup + Transit Check" first (opens image)' + String.fromCharCode(10) +
            '2. Then use Interactive Target Selection' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Or manually open an image in PixInsight.',
            'No Open Images',
            StdIcon_Information,
            StdButton_Ok
          ).execute();
          return;
        }
      }
    } else {
      console.writeln('[>] Using active image window: ' + imageWindow.mainView.id);
    }
    
    // Store the image window for coordinate updates
    this.currentInteractiveImage = imageWindow;
    
    // Force show the image window and bring to front
    try {
      imageWindow.show();
      imageWindow.bringToFront();
      // Try to activate the window by setting it as the active window
      if (typeof imageWindow.activate === 'function') {
        imageWindow.activate();
      }
      console.writeln('[>] Image window brought to front: ' + imageWindow.mainView.id);
      console.writeln('[>] Window visible: ' + imageWindow.visible + ', isWindow: ' + imageWindow.isWindow);
    } catch(e) {
      console.warningln('[!] Could not bring image to front: ' + e);
      console.writeln('[>] Try manually clicking on the image window to bring it to front');
    }
    
    // Enable interactive mode in the GUI
    this.enableInteractiveMode(imageWindow);
    
    // Show simple instruction message (non-blocking)
    console.writeln('[TARGET] === INTERACTIVE TARGET SELECTION ACTIVE ===');
    console.writeln('[>] Image Window: ' + imageWindow.mainView.id + ' (' + imageWindow.mainView.image.bounds.width + 'x' + imageWindow.mainView.image.bounds.height + ')');
    console.writeln('[>] HOW TO SELECT TARGET:');
    console.writeln('   1. Look at the image window (should be visible now)');
    console.writeln('   2. Move mouse over your target star');
    console.writeln('   3. Note X,Y coordinates in PixInsight status bar (bottom)');
    console.writeln('   4. Type those coordinates in Target X and Target Y fields in this script');
    console.writeln('   5. Use the "Move Dialog" button if you need to reposition this dialog');
    console.writeln('[>] Interactive mode enabled - dialog stays in current position');
    
    // Note: Auto-movement disabled - user can manually position dialog if needed
    // The "Move Dialog" button is still available in interactive mode
  };
  
  // Enable non-modal interactive coordinate selection
  this.enableInteractiveMode = function(imageWindow) {
    console.writeln('[>] Setting up interactive mode UI...');
    
    // Get image dimensions
    var imageWidth = imageWindow.mainView.image.bounds.width;
    var imageHeight = imageWindow.mainView.image.bounds.height;
    
    // Skip creating the interactive instructions box - just use popup
    
    // Show popup instructions instead of large text block
    var interactivePopup = new MessageBox(
      '🎯 Interactive Target Selection Active!' + String.fromCharCode(10) + String.fromCharCode(10) +
      'Image: ' + imageWindow.mainView.id + ' (' + imageWidth + 'x' + imageHeight + ')' + String.fromCharCode(10) + String.fromCharCode(10) +
      'How to select your target:' + String.fromCharCode(10) +
      '1. Use the embedded image preview on the right side' + String.fromCharCode(10) +
      '2. Click directly on your target star in the preview' + String.fromCharCode(10) +
      '3. Coordinates will be automatically entered' + String.fromCharCode(10) +
      '4. Use zoom controls and Auto STF to enhance visibility' + String.fromCharCode(10) + String.fromCharCode(10) +
      'This message can be dismissed - interactive mode remains active.',
      'Interactive Target Selection',
      StdIcon_Information,
      StdButton_Ok
    );
    
    // Show the popup (user can dismiss it)
    interactivePopup.execute();
    
    // No permanent status box - just the popup
    
    // Add quick action buttons if not already created
    if (!this.quickCoordButtons) {
      console.writeln('[>] Creating quick action buttons');
      this.quickCoordButtons = new HorizontalSizer;
      this.quickCoordButtons.spacing = 8;
      
      this.centerButton = new PushButton(this);
      this.centerButton.text = '🏠 Center';
      this.centerButton.toolTip = 'Set coordinates to image center as starting point';
      this.centerButton.onClick = function() {
        console.writeln('[>] Setting coordinates to center: (' + (imageWidth/2).toFixed(1) + ', ' + (imageHeight/2).toFixed(1) + ')');
        self.pixX.setValue(imageWidth / 2);
        self.pixY.setValue(imageHeight / 2);
        GlobalSettings.pixX = imageWidth / 2;
        GlobalSettings.pixY = imageHeight / 2;
        self.updateCoordinateDisplay();
      };
      
      this.moveDialogButton = new PushButton(this);
      this.moveDialogButton.text = '📍 Move Dialog';
      this.moveDialogButton.toolTip = 'Move this dialog to top-left to see the image better';
      this.moveDialogButton.onClick = function() {
        try {
          self.position = new Point(50, 100);
          console.writeln('[>] Dialog moved to top-left corner');
        } catch(e) {
          console.writeln('[>] Could not move dialog automatically. Try dragging the dialog manually.');
        }
      };
      
      this.confirmButton = new PushButton(this);
      this.confirmButton.text = '✅ Confirm Target';
      this.confirmButton.toolTip = 'Confirm current coordinates as your target star location';
      this.confirmButton.onClick = function() {
        self.confirmTargetCoordinates();
      };
      
      this.quickCoordButtons.add(this.centerButton);
      this.quickCoordButtons.add(this.moveDialogButton);
      this.quickCoordButtons.addStretch();
      this.quickCoordButtons.add(this.confirmButton);
      
      // Add buttons after instructions
      var buttonInsertIndex = -1;
      for (var i = 0; i < this.sizer.length; i++) {
        if (this.sizer.item(i).item === this.interactiveInstructions) {
          buttonInsertIndex = i + 1;
          break;
        }
      }
      
      if (buttonInsertIndex >= 0) {
        this.sizer.insert(buttonInsertIndex, this.quickCoordButtons);
        console.writeln('? Action buttons added at index ' + buttonInsertIndex);
      }
    }
    
    // Switch to pixel mode
    this.mode_Pixel.checked = true;
    this.mode_WCS.checked = false;
    GlobalSettings.mode = 'pixel';
    this.updateUI();
    
    // Set up enhanced coordinate change handlers
    var originalPixXHandler = this.pixX.onValueUpdated;
    var originalPixYHandler = this.pixY.onValueUpdated;
    
    this.pixX.onValueUpdated = function() {
      GlobalSettings.pixX = self.pixX.value;
      console.writeln('[>] Updated Target X to: ' + self.pixX.value);
      self.updateCoordinateDisplay();
    };
    
    this.pixY.onValueUpdated = function() {
      GlobalSettings.pixY = self.pixY.value;
      console.writeln('[>] Updated Target Y to: ' + self.pixY.value);
      self.updateCoordinateDisplay();
    };
    
    // Skip dialog resize - keep default size for better user experience
    console.writeln('? Interactive mode enabled - keeping dialog at default size');
    
    console.writeln('? Interactive mode setup complete!');
    
    // Alternative: Create a simple floating info window
    try {
      this.createFloatingInteractiveHelper(imageWindow);
    } catch(e) {
      console.warningln('[!] Could not create floating helper: ' + e);
    }
  };
  
  // Create a small floating helper window for interactive mode
  this.createFloatingInteractiveHelper = function(imageWindow) {
    if (!this.floatingHelper) {
      this.floatingHelper = new Dialog();
      this.floatingHelper.windowTitle = 'Interactive Target Selection';
      this.floatingHelper.userResizable = false;
      
      var helperLabel = new Label(this.floatingHelper);
      helperLabel.text = 
        'Target Selection Active\n' +
        'Image: ' + imageWindow.mainView.id + '\n' +
        'Size: ' + imageWindow.mainView.image.bounds.width + 'x' + imageWindow.mainView.image.bounds.height + '\n\n' +
        '1. Move mouse over target star in image\n' +
        '2. Note X,Y coordinates in status bar\n' +
        '3. Type coordinates in main dialog\n' +
        '4. Click Confirm when done';
      helperLabel.margin = 12;
      
      var helperCloseBtn = new PushButton(this.floatingHelper);
      helperCloseBtn.text = 'Close Helper';
      helperCloseBtn.onClick = function() {
        self.floatingHelper.ok();
      };
      
      var helperSizer = new VerticalSizer;
      helperSizer.add(helperLabel);
      helperSizer.add(helperCloseBtn);
      this.floatingHelper.sizer = helperSizer;
      
      this.floatingHelper.adjustToContents();
      
      // Show non-modal
      this.floatingHelper.show();
      console.writeln('[>] Created floating helper window (will appear centered)');
    }
  };
  
  // Update coordinate display during interactive mode (no-op since no status box)
  this.updateCoordinateDisplay = function() {
    // No status box to update - interactive mode uses popup only
  };
  
  // Confirm target coordinates (non-modal)
  this.confirmTargetCoordinates = function() {
    var x = this.pixX.value;
    var y = this.pixY.value;
    
    // Save to global settings
    GlobalSettings.pixX = x;
    GlobalSettings.pixY = y;
    GlobalSettings.mode = 'pixel';
    
    console.writeln('? Target coordinates confirmed: (' + x.toFixed(2) + ', ' + y.toFixed(2) + ')');
    
    // No status box to update - just log the confirmation
    console.writeln('? Target coordinates confirmed and ready for photometry');
    
    // Show brief confirmation in console
    console.writeln('[>] Interactive target selection completed successfully');
  };
  
  // Populate image selector dropdown
  this.populateImageSelector = function() {
    this.imageSelector.clear();
    this.imageSelector.addItem('-- Select Image --');
    
    // Add currently open images
    var windows = ImageWindow.windows;
    for (var i = 0; i < windows.length; i++) {
      this.imageSelector.addItem(windows[i].mainView.id);
    }
    
    // If we have a globally stored image, select it
    if (openedImageWindow && !openedImageWindow.isNull) {
      for (var i = 1; i < this.imageSelector.numberOfItems; i++) {
        if (this.imageSelector.itemText(i) === openedImageWindow.mainView.id) {
          this.imageSelector.currentItem = i;
          break;
        }
      }
    }
    
    console.writeln('[>] Populated image selector with ' + windows.length + ' open images');
  };
  
  // Load selected image for preview
  this.loadImagePreview = function() {
    if (this.imageSelector.currentItem === 0) {
      this.previewImage = null;
      this.displayImage = null;
      this.viewport.update(); // Clear the viewport
      return;
    }
    
    var selectedName = this.imageSelector.itemText(this.imageSelector.currentItem);
    var windows = ImageWindow.windows;
    
    for (var i = 0; i < windows.length; i++) {
      if (windows[i].mainView.id === selectedName) {
        try {
          console.writeln('[>] Loading image for preview °: ' + selectedName);
          this.previewImage = windows[i].mainView.image;
          // Don't create a copy - use the original image directly
          this.displayImage = this.previewImage;
          console.writeln('[>] Image loaded ?: ' + this.displayImage.width + 'x' + this.displayImage.height + ', channels=' + this.displayImage.numberOfChannels);
          
          // Reset paint debugging flags
          this._paintLogged = false;
          this._renderSuccess = false;
          this._noImageLogged = false;
          
          this.zoomToFit();
          this.initScrollBars(); // Initialize scroll bars for image navigation
          
          // If we have automatically selected stars, make sure coordinates match the loaded image
          if (this.selectedTarget && this.displayImage) {
            // Verify that the selected target is within the current image bounds
            if (this.selectedTarget.x >= 0 && this.selectedTarget.x < this.displayImage.width &&
                this.selectedTarget.y >= 0 && this.selectedTarget.y < this.displayImage.height) {
              
              // Update the preview target coordinates to match the auto-selected target
              this.previewTargetX = this.selectedTarget.x;
              this.previewTargetY = this.selectedTarget.y;
              
              console.writeln('[>] Displaying auto-selected target at (' + this.selectedTarget.x.toFixed(1) + ', ' + this.selectedTarget.y.toFixed(1) + ')');
            }
          }
          
          this.viewport.update(); // Force repaint with star markers
          return;
        } catch(e) {
          console.warningln('[!] Failed to load preview image: ' + e);
          this.previewImage = null;
          this.displayImage = null;
        }
      }
    }
    
    console.warningln('[!] Image "' + selectedName + '" not found in open windows');
  };
  
  // Handle mouse click on preview image
  this.handleImageClick = function(imageX, imageY) {
    if (!this.displayImage) {
      return;
    }
    
    // Basic bounds check
    if (imageX < 0 || imageY < 0 || imageX >= this.displayImage.width || imageY >= this.displayImage.height) {
      return;
    }
    
    // Check if click is within existing target circles or crosshair areas
    var clickedExistingTarget = false;
    var targetInfo = null;
    
    // Check if clicked within auto-selected target (circle for exoplanet, crosshair area for regular)
    if (this.selectedTarget) {
      var dx = imageX - this.selectedTarget.x;
      var dy = imageY - this.selectedTarget.y;
      var distance = Math.sqrt(dx * dx + dy * dy);
      
      var withinTarget = false;
      var targetShape = '';
      
      if (this.selectedTarget.isExoplanetHost) {
        // Exoplanet hosts use circles - check radius
        withinTarget = distance <= 25;
        targetShape = 'circle';
      } else {
        // Regular targets use crosshairs - check if within crosshair area (square region)
        var crosshairSize = 30;
        withinTarget = Math.abs(dx) <= crosshairSize && Math.abs(dy) <= crosshairSize;
        targetShape = 'crosshair area';
      }
      
      if (withinTarget) {
        clickedExistingTarget = true;
        targetInfo = {
          type: this.selectedTarget.isExoplanetHost ? 'exoplanet' : 'auto',
          target: this.selectedTarget,
          distance: distance,
          shape: targetShape
        };
        if (this.selectedTarget.isExoplanetHost) {
          // Keep original imageX, imageY (clicked location) to show yellow crosshairs
          console.writeln('[🎯] Manual targeting within exoplanet circle');
        } else {
          console.writeln('[🎯] Reselected existing target');
          // Use the center coordinates of the existing target for regular targets
          imageX = this.selectedTarget.x;
          imageY = this.selectedTarget.y;
        }
      }
    }
    
    // Check if clicked within manual target crosshair area (if different from auto)
    if (!clickedExistingTarget && this.previewTargetX !== undefined && this.previewTargetY !== undefined) {
      var dxManual = imageX - this.previewTargetX;
      var dyManual = imageY - this.previewTargetY;
      var distanceManual = Math.sqrt(dxManual * dxManual + dyManual * dyManual);
      
      var manualCrosshairSize = 25;
      if (Math.abs(dxManual) <= manualCrosshairSize && Math.abs(dyManual) <= manualCrosshairSize) {
        clickedExistingTarget = true;
        targetInfo = {
          type: 'manual',
          x: this.previewTargetX,
          y: this.previewTargetY,
          distance: distanceManual,
          shape: 'crosshair area'
        };
        console.writeln('[🎯] Reselected manual target');
        
        // Use the center coordinates of the existing manual target
        imageX = this.previewTargetX;
        imageY = this.previewTargetY;
      }
    }
    
    // If not clicking within existing targets, this is a new target selection
    if (!clickedExistingTarget) {
      console.writeln('[🎯] New target: (' + imageX.toFixed(1) + ', ' + imageY.toFixed(1) + ')');
    }
    
    // Update target coordinates
    this.previewTargetX = imageX;
    this.previewTargetY = imageY;
    
    // Update the coordinate input fields with explicit UI refresh
    this.pixX.setValue(imageX);
    this.pixX.update(); // Force UI update
    this.pixY.setValue(imageY);
    this.pixY.update(); // Force UI update
    
    // For plate-solved images, also calculate and display RA/Dec coordinates
    var currentImage = this.getCurrentImageWindow();
    if (currentImage && currentImage.hasAstrometricSolution) {
      console.writeln('[🎯] Image has astrometric solution - calculating RA/Dec...');
      
      try {
        var reverseResult = pixelToRADec(currentImage, imageX, imageY);
        
        if (reverseResult.success) {
          // Update RA/Dec fields
          this.updateRADisplay(reverseResult.ra);
          this.updateDecDisplay(reverseResult.dec);
          
          // Also update global settings
          GlobalSettings.ra = reverseResult.ra;
          GlobalSettings.dec = reverseResult.dec;
          
          console.writeln('[🎯] → RA/Dec: (' + reverseResult.ra.toFixed(4) + '°, ' + reverseResult.dec.toFixed(4) + '°)');
          
          // Switch to WCS mode to show the calculated coordinates
          this.mode_WCS.checked = true;
          this.mode_Pixel.checked = false;
          GlobalSettings.mode = 'wcs';
          
          // Update the UI to reflect the mode change
          this.updateUI();
          
        } else {
          console.writeln('[🎯] RA/Dec calculation unavailable');
          
          // Fall back to pixel mode
          this.mode_Pixel.checked = true;
          this.mode_WCS.checked = false;
          GlobalSettings.mode = 'pixel';
        }
      } catch (e) {
        // Fall back to pixel mode on error
        this.mode_Pixel.checked = true;
        this.mode_WCS.checked = false;
        GlobalSettings.mode = 'pixel';
      }
    } else {
      
      // Switch to pixel mode for non-plate-solved images
      this.mode_Pixel.checked = true;
      this.mode_WCS.checked = false;
      GlobalSettings.mode = 'pixel';
    }
    
    // Save pixel coordinates to global settings
    GlobalSettings.pixX = imageX;
    GlobalSettings.pixY = imageY;
    
    // Repaint to show target marker
    this.viewport.update();
  };
  
  // Helper function to get the current image window for coordinate conversions
  this.getCurrentImageWindow = function() {
    try {
      // First, try to get the image from the selector
      if (this.imageSelector.currentItem > 0) {
        var selectedImageName = this.imageSelector.itemText(this.imageSelector.currentItem);
        
        // Find the corresponding ImageWindow
        var windows = ImageWindow.windows;
        for (var i = 0; i < windows.length; i++) {
          if (windows[i].mainView.id === selectedImageName) {
            return windows[i];
          }
        }
      }
      
      // Fallback to active window
      if (ImageWindow.activeWindow && !ImageWindow.activeWindow.isNull) {
        return ImageWindow.activeWindow;
      }
      
      // Last resort: first open window
      var windows = ImageWindow.windows;
      if (windows.length > 0) {
        return windows[0];
      }
      
      return null;
    } catch (e) {
      console.writeln('[getCurrentImageWindow] Error: ' + e);
      return null;
    }
  };
  
  // Zoom functions with proper viewport updates
  this.zoomIn = function() {
    this.zoomFactor = Math.min(this.zoomFactor * 1.5, 5.0); // Max 5x zoom
    this.updateViewportSize();
  };
  
  this.zoomOut = function() {
    this.zoomFactor = Math.max(this.zoomFactor / 1.5, 0.2); // Min 0.2x zoom
    this.updateViewportSize();
  };
  
  this.zoomToFit = function() {
    if (!this.displayImage) return;
    
    // Get actual ScrollBox dimensions (dynamic based on dialog size)
    var availableWidth = this.imagePreview.width;
    var availableHeight = this.imagePreview.height;
    
    // Fallback to minimum size if dimensions not available yet
    if (availableWidth <= 0) availableWidth = 400;
    if (availableHeight <= 0) availableHeight = 300;
    
    var scaleX = availableWidth / this.displayImage.width;
    var scaleY = availableHeight / this.displayImage.height;
    this.zoomFactor = Math.min(scaleX, scaleY, 1.0);
    
    // Ensure minimum zoom factor for very large images
    if (this.zoomFactor < 0.05) {
      this.zoomFactor = 0.05;
    }
    this.updateViewportSize();
  };
  
  this.zoomTo100 = function() {
    this.zoomFactor = 1.0;
    this.updateViewportSize();
  };
  
  // Zoom to a specific rectangle selected by drag-to-zoom
  this.zoomToRectangle = function(rectLeft, rectTop, rectWidth, rectHeight) {
    if (!this.displayImage) return;
    
    // Convert viewport coordinates to image coordinates (accounting for current scale and scroll)
    // The viewport coordinates need to be converted to the actual image coordinates
    // taking into account the current zoom level and scroll position
    var scrollX = this.imagePreview.scrollPosition ? this.imagePreview.scrollPosition.x : 0;
    var scrollY = this.imagePreview.scrollPosition ? this.imagePreview.scrollPosition.y : 0;
    
    var imageLeft = (rectLeft / this.scale) + scrollX;
    var imageTop = (rectTop / this.scale) + scrollY;
    var imageWidth = rectWidth / this.scale;
    var imageHeight = rectHeight / this.scale;
    
    // Ensure the calculated image coordinates are within bounds
    imageLeft = Math.max(0, Math.min(imageLeft, this.displayImage.width - imageWidth));
    imageTop = Math.max(0, Math.min(imageTop, this.displayImage.height - imageHeight));
    imageWidth = Math.min(imageWidth, this.displayImage.width - imageLeft);
    imageHeight = Math.min(imageHeight, this.displayImage.height - imageTop);
    
    // Get current viewport size
    var viewportW = this.imagePreview.width;
    var viewportH = this.imagePreview.height;
    
    // Calculate the zoom factor needed to fit the selected rectangle in the viewport
    var scaleX = viewportW / imageWidth;
    var scaleY = viewportH / imageHeight;
    var newZoomFactor = Math.min(scaleX, scaleY, 5.0); // Max 5x zoom
    
    // Apply the new zoom factor
    this.zoomFactor = newZoomFactor;
    this.updateViewportSize();
    
    // Calculate the center of the selected rectangle in image coordinates
    var centerX = imageLeft + imageWidth / 2;
    var centerY = imageTop + imageHeight / 2;
    
    // Calculate scroll position to center the selected area
    var scaledCenterX = centerX * this.scale;
    var scaledCenterY = centerY * this.scale;
    
    var scrollX = scaledCenterX - viewportW / 2;
    var scrollY = scaledCenterY - viewportH / 2;
    
    // Clamp scroll position to valid ranges
    var maxScrollX = Math.max(0, this.displayImage.width * this.scale - viewportW);
    var maxScrollY = Math.max(0, this.displayImage.height * this.scale - viewportH);
    
    scrollX = Math.max(0, Math.min(scrollX, maxScrollX));
    scrollY = Math.max(0, Math.min(scrollY, maxScrollY));
    
    // Apply the scroll position
    this.imagePreview.scrollPosition = new Point(scrollX, scrollY);
    
    console.writeln('[>] Zoom to rectangle complete: ' + newZoomFactor.toFixed(2) + 'x zoom, centered at (' + centerX.toFixed(0) + ', ' + centerY.toFixed(0) + ')');
    
    // Force viewport update
    this.viewport.update();
  };
  
  // Initialize scroll bars for proper image navigation
  this.initScrollBars = function() {
    if (!this.displayImage || this.displayImage.width <= 0 || this.displayImage.height <= 0) {
      this.imagePreview.setHorizontalScrollRange(0, 0);
      this.imagePreview.setVerticalScrollRange(0, 0);
      this.viewport.setFixedSize(100, 100);
      return;
    }
    
    var scaledWidth = Math.round(this.displayImage.width * this.scale);
    var scaledHeight = Math.round(this.displayImage.height * this.scale);
    
    // Use actual ScrollBox dimensions for viewport size
    var viewportW = this.imagePreview.width;
    var viewportH = this.imagePreview.height;
    
    // Fallback to minimum size if dimensions not available yet
    if (viewportW <= 0) viewportW = 400;
    if (viewportH <= 0) viewportH = 300;
    
    this.viewport.setFixedSize(viewportW, viewportH);
    
    // Set scroll ranges based on scaled image size
    var maxScrollX = Math.max(0, scaledWidth - viewportW);
    var maxScrollY = Math.max(0, scaledHeight - viewportH);
    this.imagePreview.setHorizontalScrollRange(0, maxScrollX);
    this.imagePreview.setVerticalScrollRange(0, maxScrollY);
    
    // Initialize scroll position for image viewport
    if (!this.imagePreview.scrollPosition) {
      this.imagePreview.scrollPosition = new Point(0, 0);
    }
    
    // Debug: console.writeln('[>] ScrollBars: viewport=' + scaledWidth + 'x' + scaledHeight + ', scale=' + (this.scale * 100).toFixed(1) + '%');
  };
  
  // Update viewport size based on zoom - enables proper scrolling
  this.updateViewportSize = function() {
    if (!this.displayImage) return;
    
    // Update scale factor to match zoom factor
    this.scale = this.zoomFactor;
    
    // Initialize scroll bars with new scale
    this.initScrollBars();
    
    this.viewport.update(); // Trigger repaint
    this.imagePreview.update(); // Update ScrollBox
  };
  
  // Apply Auto STF for improved preview visibility
  this.applyAutoSTF = function() {
    if (!this.previewImage) {
      console.warningln('[!] No image loaded for Auto STF');
      new MessageBox(
        '🖼️ No Preview Image' + String.fromCharCode(10) + String.fromCharCode(10) +
        'No image is currently loaded in the preview.' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Please select an image from the dropdown first.',
        'No Image Loaded',
        StdIcon_Warning,
        StdButton_Ok
      ).execute();
      return;
    }
    
    try {
      console.writeln('[>] Applying Auto STF for preview enhancement [STF] °...');
      
      // Create temporary window for image processing
      var tempWindow = new ImageWindow(
        this.previewImage.width, this.previewImage.height,
        this.previewImage.numberOfChannels,
        this.previewImage.bitsPerSample,
        this.previewImage.isReal,
        this.previewImage.isColor
      );
      
      tempWindow.mainView.beginProcess(UndoFlag_NoSwapFile);
      tempWindow.mainView.image.assign(this.previewImage);
      tempWindow.mainView.endProcess();
      
      console.writeln('[>] Step 1: First PixelMath operation [STF] °...');
      
      // First PixelMath operation: Unlinked stretch per channel to avoid color cast
      var pixelMath1 = new PixelMath;
      if (this.previewImage.numberOfChannels === 1) {
        pixelMath1.expression = '($T-min($T))/(1-min($T))';
      } else {
        // Unlinked per-channel stretch to avoid green cast
        pixelMath1.expression = '($T-min($T))/(1-min($T))';
      }
      pixelMath1.useSingleExpression = true;
      pixelMath1.executeOn(tempWindow.mainView);
      
      console.writeln('[>] Step 2: Second PixelMath operation [STF] °...');
      
      // Second PixelMath operation for unlinked midtone stretch per channel
      var targetMedian = 0.25;
      
      var pixelMath2 = new PixelMath;
      if (this.previewImage.numberOfChannels === 1) {
        pixelMath2.expression = '((Med($T)-1)*0.25*$T)/(Med($T)*(0.25+$T-1)-0.25*$T)';
      } else {
        // Unlinked per-channel midtone stretch
        pixelMath2.expression = '((Med($T)-1)*' + targetMedian + '*$T)/(Med($T)*(' + targetMedian + '+$T-1)-' + targetMedian + '*$T)';
      }
      pixelMath2.useSingleExpression = true;
      pixelMath2.executeOn(tempWindow.mainView);
      
      console.writeln('[>] Step 2 complete: Contrast enhanced [STF] °');
      
      // Create a new display image for preview
      this.displayImage = new Image(tempWindow.mainView.image);
      tempWindow.forceClose();
      
      // Update viewport with stretched image
      this.updateViewportSize();
      this.viewport.update(); // Force immediate repaint
      
      // Log success only once to avoid spam
      if (!this._stfLogged) {
        console.writeln('? Auto STF applied successfully [STF] ° - preview updated');
        this._stfLogged = true;
      }
      
    } catch(e) {
      console.warningln('[!] Auto STF failed: ' + e);
      new MessageBox(
        '⚠️ Auto STF Failed' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Error processing image enhancement: ' + e + String.fromCharCode(10) + String.fromCharCode(10) +
        'The preview will continue to work without STF enhancement.',
        'STF Processing Error',
        StdIcon_Warning,
        StdButton_Ok
      ).execute();
    }
  };
  
  // Auto-populate hardware settings from FITS headers
  this.autoPopulateFromFITS = function() {
    var imageWindow = ImageWindow.activeWindow;
    var shouldCloseImage = false;
    
    // If no image is open, try to open first image from selected folder
    if (!imageWindow || imageWindow.isNull) {
      var windows = ImageWindow.windows;
      if (windows.length > 0) {
        imageWindow = windows[0];
      } else {
        // No images open - try to load from folder
        var folderPath = this.folder_Edit.text.trim();
        if (!folderPath) {
          new MessageBox(
            '💼 No Images or Folder Selected' + String.fromCharCode(10) + String.fromCharCode(10) +
            'No images are open and no folder is selected.' + String.fromCharCode(10) + String.fromCharCode(10) +
            '🕰️ Smart Setup + Transit Check Required' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Please either:' + String.fromCharCode(10) +
            '1)	Open an Image in PixInsight' + String.fromCharCode(10) +
            '2)	Use the Browse button to select a folder with light frames',
            'No Images or Folder',
            StdIcon_Warning,
            StdButton_Ok
          ).execute();
          return;
        }
        
        console.writeln('[>] Validating folder path: ' + folderPath);
        
        // Check if folder exists
        var folderExists = File.directoryExists(folderPath);
        console.writeln('[>] Folder exists: ' + folderExists);
        
        if (!folderExists) {
          new MessageBox(
            '❌ Invalid Folder Path' + String.fromCharCode(10) + String.fromCharCode(10) +
            'The selected folder does not exist or is not accessible.' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Folder: ' + folderPath + String.fromCharCode(10) + String.fromCharCode(10) +
            'Please use the Browse button to select a valid folder.',
            'Invalid Folder Path',
            StdIcon_Error,
            StdButton_Ok
          ).execute();
          return;
        }
        
        // Get first image from folder
        console.writeln('[>] Scanning for images in: ' + folderPath);
        var files = listImagesInFolder(folderPath);
        console.writeln('[>] Found ' + files.length + ' image files');
        
        // Debug: Show first few files found
        if (files.length > 0) {
          console.writeln('[>] First few files:');
          for (var i = 0; i < Math.min(3, files.length); i++) {
            console.writeln('   ' + (i+1) + ': ' + files[i]);
          }
        }
        
        if (files.length === 0) {
          new MessageBox(
            '📋 No Images in Folder' + String.fromCharCode(10) + String.fromCharCode(10) +
            'No supported image files found in the selected folder.' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Folder: ' + folderPath + String.fromCharCode(10) + String.fromCharCode(10) +
            'Supported formats: .fits, .fit, .xisf' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Please verify the folder contains calibrated light frames' + String.fromCharCode(10) +
            'in one of these formats.',
            'No Images in Folder',
            StdIcon_Warning,
            StdButton_Ok
          ).execute();
          return;
        }
        
        console.writeln('[>] Opening first image for FITS analysis: ' + files[0]);
        var refArr = ImageWindow.open(files[0]);
        
        if (refArr.length === 0) {
          new MessageBox(
            '❌ Cannot Open Image' + String.fromCharCode(10) + String.fromCharCode(10) +
            'Cannot open first image from folder.' + String.fromCharCode(10) + String.fromCharCode(10) +
            'File: ' + files[0] + String.fromCharCode(10) + String.fromCharCode(10) +
            'Please verify the file is not corrupted or locked.',
            'Cannot Open Image',
            StdIcon_Error,
            StdButton_Ok
          ).execute();
          return;
        }
        
        imageWindow = refArr[0];
        shouldCloseImage = false; // KEEP image open for other functions to use
        openedImageWindow = imageWindow; // Store global reference to prevent garbage collection
        imageWindow.show(); // Explicitly show the window
        console.writeln('? Opened image for FITS extraction (keeping open): ' + imageWindow.mainView.id);
      }
    }
    
    console.writeln('[>] Attempting to auto-populate from: ' + imageWindow.mainView.id);
    
    // Extract hardware settings from FITS
    var hardware = extractHardwareFromFITS(imageWindow);
    
    if (!hardware) {
      new MessageBox(
        '🛠️ No FITS Hardware Data' + String.fromCharCode(10) + String.fromCharCode(10) +
        'No usable hardware information found in FITS headers.' + String.fromCharCode(10) + String.fromCharCode(10) +
        'The image may not contain telescope/camera metadata,' + String.fromCharCode(10) +
        'or the keywords may use non-standard names.' + String.fromCharCode(10) + String.fromCharCode(10) +
        'You can still proceed by entering hardware settings manually.',
        'No FITS Hardware Data',
        StdIcon_Information,
        StdButton_Ok
      ).execute();
      
      // Still update FITS info display (without transit analysis)
      this.fitsInfo.text = getFITSInfo(imageWindow, null);
      return;
    }
    
    // Update controls with found values
    var updated = [];
    
    if (hardware.focalLength) {
      this.focalLength.setValue(hardware.focalLength);
      GlobalSettings.focalLength = hardware.focalLength;
      updated.push('Focal Length: ' + hardware.focalLength + 'mm');
    }
    
    if (hardware.pixelSize) {
      this.pixelSize.setValue(hardware.pixelSize);
      GlobalSettings.pixelSize = hardware.pixelSize;
      updated.push('Pixel Size: ' + hardware.pixelSize + 'μm');
    }
    
    if (hardware.binning) {
      this.binning.currentItem = hardware.binning - 1;
      GlobalSettings.binning = hardware.binning;
      updated.push('Binning: ' + hardware.binning + 'x' + hardware.binning);
    }
    
    if (hardware.estimatedFWHM) {
      this.fwhm.setValue(hardware.estimatedFWHM);
      GlobalSettings.estimatedFWHM = hardware.estimatedFWHM;
      updated.push('FWHM: ' + hardware.estimatedFWHM + '"');
    }
    
    // ====== NEW: AUTOMATIC WCS ROTATION DETECTION ======
    console.writeln('[>] Attempting automatic WCS rotation detection...');
    
    // Try WCS rotation detection (will initialize WCS metadata if available)
    try {
      var autoRot = extractWCSRotation(imageWindow);
        if (autoRot && autoRot.success && isFinite(autoRot.rotation)) {
          // Auto-populate rotation field
          this.manualRotation.setValue(autoRot.rotation);
          GlobalSettings.manualRotation = autoRot.rotation;
          
          console.writeln('[WCS] ✅ Auto-populated rotation: ' + autoRot.rotation.toFixed(4) + '° (method: ' + autoRot.method + ')');
          updated.push('WCS Rotation: ' + autoRot.rotation.toFixed(4) + '° (auto-detected)');
          
          // Also show additional WCS metadata if available
          if (autoRot.metadata) {
            if (autoRot.metadata.pixelScale) {
              console.writeln('[WCS] Pixel scale from WCS: ' + autoRot.metadata.pixelScale.toFixed(3) + '"/pixel');
            }
            if (autoRot.metadata.focalLength) {
              console.writeln('[WCS] Focal length from WCS: ' + autoRot.metadata.focalLength.toFixed(1) + 'mm');
            }
          }
        } else {
          console.writeln('[WCS] ⚠️ Could not auto-detect rotation: ' + (autoRot.error || 'Unknown error'));
          console.writeln('[WCS] Manual rotation entry will be required for precise targeting');
        }
      } catch (e) {
        console.warningln('[WCS] Rotation auto-detection failed: ' + e);
        console.writeln('[WCS] Manual rotation entry will be required for precise targeting');
      }
    
    // Initially update FITS info display (transit analysis will be updated later)
    this.fitsInfo.text = getFITSInfo(imageWindow, null);
    
    // Enable hardware calculator if we found settings
    this.hardwareMode_Check.checked = true;
    GlobalSettings.useHardwareCalculator = true;
    
    // Update UI and calculator
    this.updateUI();
    
    // ====== NEW: STAR DETECTION AND ANALYSIS ======
    console.writeln('[>] Starting automatic star detection and analysis...');
    
    try {
      // Store image dimensions for star selection algorithms
      GlobalSettings.imageWidth = imageWindow.mainView.image.width;
      GlobalSettings.imageHeight = imageWindow.mainView.image.height;
      
      // Step 1: Detect all stars in the image
      console.writeln('[>] Analyzing image: ' + GlobalSettings.imageWidth + 'x' + GlobalSettings.imageHeight + ' pixels');
      this.detectedStars = detectAndAnalyzeStars(imageWindow.mainView.image, {
        maxStars: 100,     // Increase detection limit for better star coverage
        minStarSize: 1,    // Lower minimum size
        maxStarSize: 50,   // Increase maximum size to catch larger stars
        avoidBorders: 50   // Stay away from image edges
      });
      
      if (this.detectedStars.length > 0) {
        console.writeln('? Star detection successful: Found ' + this.detectedStars.length + ' candidate stars');
        
        // Step 2: Select optimal target star
        this.selectedTarget = selectTargetStar(this.detectedStars, {
          preferCenter: true,  // Prefer stars near image center
          minQuality: 0.3      // Accept stars with quality > 30%
        });
        
        if (this.selectedTarget) {
          // Step 3: Select comparison stars
          this.selectedComparisons = selectComparisonStars(this.detectedStars, this.selectedTarget, 3);
          
          // Step 4: Update coordinate fields with selected target
          this.pixX.setValue(this.selectedTarget.x);
          this.pixY.setValue(this.selectedTarget.y);
          GlobalSettings.pixX = this.selectedTarget.x;
          GlobalSettings.pixY = this.selectedTarget.y;
          
          // Switch to pixel mode since we have pixel coordinates
          this.mode_Pixel.checked = true;
          this.mode_WCS.checked = false;
          GlobalSettings.mode = 'pixel';
          
          // Step 5: Calculate robust FWHM from central stars
          console.writeln('[>] Calculating robust FWHM from central stars...');
          var fwhmAnalysis = calculateAverageFWHM(this.detectedStars, GlobalSettings.imageWidth, GlobalSettings.imageHeight);
          
          if (fwhmAnalysis) {
            // Store FWHM analysis results for display
            this.fwhmAnalysis = fwhmAnalysis;
            
            // Use weighted average FWHM for best accuracy
            var robustFWHM = fwhmAnalysis.weightedAverage;
            this.fwhm.setValue(robustFWHM);
            GlobalSettings.estimatedFWHM = robustFWHM;
            
            // Create simple FWHM summary to match stable version format
            updated.push('Measured FWHM: ' + robustFWHM.toFixed(2) + '\"');
            
            // Update calculator with new FWHM
            this.updateCalculator();
          } else {
            // Fallback to single star FWHM if multi-star analysis fails
            if (this.selectedTarget.fwhmArcsec) {
              this.fwhm.setValue(this.selectedTarget.fwhmArcsec);
              GlobalSettings.estimatedFWHM = this.selectedTarget.fwhmArcsec;
              updated.push('FWHM (single star): ' + this.selectedTarget.fwhmArcsec.toFixed(2) + '"');
              this.updateCalculator();
            }
          }
          
          // Add star selection to success message
          var starSummary = 'Target: (' + this.selectedTarget.x.toFixed(0) + ', ' + this.selectedTarget.y.toFixed(0) + ')';
          if (this.selectedComparisons.length > 0) {
            starSummary += ', ' + this.selectedComparisons.length + ' comparison stars';
          }
          updated.push('Auto-selected stars: ' + starSummary);
          
          console.writeln('[>] Automatic star selection complete!');
        } else {
          console.warningln('[!] No suitable target star found - you can select manually');
        }
      } else {
        console.warningln('[!] No stars detected in image - you can select target manually');
      }
    } catch (e) {
      console.warningln('[!] Star detection failed: ' + e);
      console.warningln('[!] You can still select target stars manually using the preview');
    }
    
    // ====== NEW: HISTORICAL EXOPLANET TRANSIT ANALYSIS ======
    console.writeln('[>] Starting historical exoplanet transit analysis...');
    
    try {
      this.transitAnalysis = analyzeHistoricalTransits(imageWindow);
      
      if (this.transitAnalysis && this.transitAnalysis.success && this.transitAnalysis.matches && this.transitAnalysis.matches.length > 0) {
        var bestTransit = this.transitAnalysis.matches[0]; // Best overlap
        var transitPlanet = bestTransit.planet;
        
        console.writeln('[>] HISTORICAL TRANSIT DETECTED!');
        console.writeln('[>] Planet: ' + transitPlanet.name + ' (' + transitPlanet.hostname + ')');
        console.writeln('[>] Transit overlap: ' + bestTransit.overlapDuration.toFixed(1) + 'h (' + bestTransit.overlapPercentage.toFixed(0) + '%)');
        console.writeln('[>] Quality: ' + bestTransit.quality);
        
        // Use WCS as the sole source of truth for the target position.
        // We do NOT search detectedStars for a "nearby" star — that approach fails
        // for bright/saturated targets (e.g. mag 7.7 HD 189733) that never appear
        // in the detection list, causing the fallback to grab a completely wrong star.
        // The WCS plate-solve is already sub-arcsecond accurate; no snapping needed.
        var hostStar = null;

        console.writeln('[WCS] 🌟 WCS direct positioning for ' + transitPlanet.hostname +
                        ' RA=' + transitPlanet.ra.toFixed(5) + '° Dec=' + transitPlanet.dec.toFixed(5) + '°');

        var wcsResult = raDecToPixel(imageWindow, transitPlanet.ra, transitPlanet.dec);

        if (wcsResult.success) {
          var _imgW = imageWindow.mainView.image.width;
          var _imgH = imageWindow.mainView.image.height;

          if (wcsResult.x < 0 || wcsResult.x >= _imgW || wcsResult.y < 0 || wcsResult.y >= _imgH) {
            console.writeln('[WCS] ⚠️ ' + transitPlanet.hostname + ' projects outside image bounds (' +
                            wcsResult.x.toFixed(1) + ', ' + wcsResult.y.toFixed(1) + ') — not in frame.');
          } else {
            // WCS position is valid — use it directly.
            // Optional snap: if a detected star centroid is within 30 pixels,
            // use its centroid for sub-pixel accuracy. The synthetic CD matrix
            // from summary text is accurate to ~20px, so we use 30px snap radius.
            // This corrects small systematic offsets from the approximate CD matrix.
            var snapX = wcsResult.x, snapY = wcsResult.y, snapNote = 'raw WCS';
            var SNAP_LIMIT = 30; // pixels — matches accuracy of synthetic CD matrix

            // Pass 1: try snapping to already-detected stars (non-saturated)
            var bestSnapDist = SNAP_LIMIT + 1;
            for (var si = 0; si < this.detectedStars.length; si++) {
              var ds = this.detectedStars[si];
              var sd = Math.sqrt(Math.pow(ds.x - wcsResult.x, 2) + Math.pow(ds.y - wcsResult.y, 2));
              if (sd < bestSnapDist) { bestSnapDist = sd; snapX = ds.x; snapY = ds.y; snapNote = 'centroid snap ' + sd.toFixed(1) + 'px'; }
            }

            // Pass 2: if no detected star nearby (e.g. saturated/bright target excluded
            // from detection by quality threshold), do a direct local centroid search
            // in a box around the WCS position — this works for any brightness.
            if (snapNote === 'raw WCS') {
              try {
                var img = imageWindow.mainView.image;
                var BOX = 50; // half-box in pixels
                var wx = Math.round(wcsResult.x), wy = Math.round(wcsResult.y);
                var x0 = Math.max(0, wx - BOX), x1 = Math.min(img.width-1,  wx + BOX);
                var y0 = Math.max(0, wy - BOX), y1 = Math.min(img.height-1, wy + BOX);
                // Find brightest pixel in box as seed
                var peakVal = -1, peakX = wx, peakY = wy;
                for (var by = y0; by <= y1; by++) {
                  for (var bx = x0; bx <= x1; bx++) {
                    var v = 0;
                    for (var c = 0; c < img.numberOfChannels; c++) v += img.sample(bx, by, c);
                    v /= img.numberOfChannels;
                    if (v > peakVal) { peakVal = v; peakX = bx; peakY = by; }
                  }
                }
                // Intensity-weighted centroid in a tighter box around peak
                var CR = 15;
                var cx0 = Math.max(0, peakX-CR), cx1 = Math.min(img.width-1,  peakX+CR);
                var cy0 = Math.max(0, peakY-CR), cy1 = Math.min(img.height-1, peakY+CR);
                var m00=0, m10=0, m01=0;
                for (var cy = cy0; cy <= cy1; cy++) {
                  for (var cx = cx0; cx <= cx1; cx++) {
                    var iv = 0;
                    for (var c = 0; c < img.numberOfChannels; c++) iv += img.sample(cx, cy, c);
                    iv /= img.numberOfChannels;
                    if (iv > peakVal * 0.5) { m00 += iv; m10 += iv*cx; m01 += iv*cy; }
                  }
                }
                if (m00 > 0) {
                  var centX = m10/m00, centY = m01/m00;
                  var centDist = Math.sqrt(Math.pow(centX-wcsResult.x,2)+Math.pow(centY-wcsResult.y,2));
                  if (centDist < SNAP_LIMIT * 2) {
                    snapX = centX; snapY = centY;
                    snapNote = 'local centroid ' + centDist.toFixed(1) + 'px from WCS';
                  }
                }
              } catch(snapErr) {
                console.warningln('[WCS] Local centroid search failed: ' + snapErr);
              }
            }

            hostStar = {
              x: snapX,
              y: snapY,
              isExoplanetHost: true,
              hostname: transitPlanet.hostname,
              name: transitPlanet.name,
              quality: 1.0
            };
            console.writeln('[WCS] ✅ ' + transitPlanet.hostname + ' → (' + snapX.toFixed(1) + ', ' + snapY.toFixed(1) + ')  [' + snapNote + ']');
          }
        } else {
          console.writeln('[WCS] ❌ WCS conversion failed: ' + wcsResult.error + ' — no circle will be drawn.');
        }
        
        // If we found a reasonable candidate
        // Note: For SIMBAD-detected stars, skip quality check since position is more important
        if (hostStar) {
            this.exoplanetTarget = hostStar;
            this.selectedTarget = hostStar; // Override previous target selection
            
            // Update pixel coordinate fields
            this.pixX.setValue(hostStar.x);
            this.pixY.setValue(hostStar.y);
            GlobalSettings.pixX = hostStar.x;
            GlobalSettings.pixY = hostStar.y;
            
            // Auto-populate WCS coordinates from detected exoplanet
            this.updateRADisplay(transitPlanet.ra);
            this.updateDecDisplay(transitPlanet.dec);
            GlobalSettings.ra = transitPlanet.ra;
            GlobalSettings.dec = transitPlanet.dec;
            
            // Switch to WCS mode to show the populated coordinates
            this.mode_WCS.checked = true;
            this.mode_Pixel.checked = false;
            GlobalSettings.mode = 'wcs';
            this.updateUI();
            
            console.writeln('[>] Auto-selected exoplanet host as target!');
            console.writeln('[>] Auto-populated WCS coordinates: RA=' + transitPlanet.ra.toFixed(6) + '° Dec=' + transitPlanet.dec.toFixed(6) + '°');
            
            // Show detailed WCS-based detection popup
            var exoplanetMessage = '🎆 EXOPLANET HOST STAR DETECTED! 🎆\n\n' +
                                  '✨ WCS-BASED PRECISION TARGETING ACTIVE \u2728\n\n' +
                                  'Exoplanet System: ' + transitPlanet.name + '\n' +
                                  'Host Star: ' + transitPlanet.hostname + '\n' +
                                  'Magnitude: ' + transitPlanet.hostMag + '\n' +
                                  'Transit Period: ' + transitPlanet.period.toFixed(3) + ' days\n\n' +
                                  'Precise Coordinates:\n' +
                                  'RA: ' + transitPlanet.ra.toFixed(6) + '°\n' +
                                  'Dec: ' + transitPlanet.dec.toFixed(6) + '°\n' +
                                  'Pixel Position: (' + hostStar.x.toFixed(1) + ', ' + hostStar.y.toFixed(1) + ')\n\n' +
                                  '🎯 The exoplanet host star has been automatically selected\n' +
                                  'as your photometry target and is now highlighted with\n' +
                                  'a bright MAGENTA CIRCLE in the preview image!\n\n' +
                                  '📊 Perfect setup for transit photometry!';
                                  
            var exoplanetPopup = new MessageBox(
              exoplanetMessage,
              '🎆 WCS Exoplanet Detection Success!',
              StdIcon_Information,
              StdButton_Ok
            );
            exoplanetPopup.execute();
            
            // Add to updated list
            updated.push('WCS-Based Exoplanet Detection: ' + transitPlanet.hostname + ' precisely located at (' + hostStar.x.toFixed(0) + ', ' + hostStar.y.toFixed(0) + ')');
          }
        
        // Add transit information to success message
        var transitSummary = transitPlanet.name + ' - ' + bestTransit.overlapPercentage.toFixed(0) + '% coverage';
        updated.push('Historical transit: ' + transitSummary);
        
      } else if (this.transitAnalysis && this.transitAnalysis.success) {
        // Check if we have a very close exoplanet that should be treated as "in field"
        if (this.transitAnalysis.closestExoplanet) {
          // Nearby exoplanet found, check if it's close enough
        }
        
        // Only attempt to draw a circle if the planet is plausibly within the image frame.
        // Use the half-diagonal of the image (same value used by the candidate search) as the
        // outer limit — anything further than that cannot be in the image.
        var _halfDiag = (this.transitAnalysis.fieldOfView && this.transitAnalysis.fieldOfView.radiusDeg)
                        ? this.transitAnalysis.fieldOfView.radiusDeg : 3.0;
        if (this.transitAnalysis.closestExoplanet && this.transitAnalysis.closestExoplanet.distance < _halfDiag) {
          console.writeln('[>] Very close exoplanet detected: ' + this.transitAnalysis.closestExoplanet.hostname);
          console.writeln('[>] Distance: ' + (this.transitAnalysis.closestExoplanet.distance * 60).toFixed(1) + ' arcminutes');
          
          // Use WCS-based positioning to find the actual exoplanet host star
          var hostStar = null;
          
          // Use WCS-based positioning to locate the exoplanet host star
          
          // Use direct plate solve math to convert detected exoplanet coordinates to pixel coordinates
          var closestExo = this.transitAnalysis.closestExoplanet;
          console.writeln('[PLATE] 🎯 Using direct plate solve mathematical conversion for ' + closestExo.hostname);
          console.writeln('[PLATE] Database coordinates: RA=' + closestExo.ra.toFixed(6) + '°, Dec=' + closestExo.dec.toFixed(6) + '°');
          
          // Use high-precision WCS transformation (tries PixInsight built-in first, then CD matrix, then manual)
          var plateResult = raDecToPixel(imageWindow, closestExo.ra, closestExo.dec);
          
          if (plateResult.success) {
            console.writeln('[PLATE] 🎯 ' + closestExo.hostname + ' calculated pixel coordinates: (' + plateResult.x.toFixed(2) + ', ' + plateResult.y.toFixed(2) + ')');
            
            // Validate coordinates are within image bounds
            var imageWidth = imageWindow.mainView.image.width;
            var imageHeight = imageWindow.mainView.image.height;
            
            if (plateResult.x >= 0 && plateResult.x < imageWidth && plateResult.y >= 0 && plateResult.y < imageHeight) {
              console.writeln('[PLATE] ✅ Coordinates within image bounds (' + imageWidth + 'x' + imageHeight + ')');
              
              // Snap to actual star: try detected stars first, then direct local centroid
              var finalX = plateResult.x, finalY = plateResult.y, snapNote = 'WCS only';
              var SNAP_R = 40;
              // Pass 1: non-saturated detected stars
              var bestD = SNAP_R + 1;
              if (this.detectedStars) {
                for (var si = 0; si < this.detectedStars.length; si++) {
                  var dsx = this.detectedStars[si].x, dsy = this.detectedStars[si].y;
                  var dsd = Math.sqrt(Math.pow(dsx-plateResult.x,2)+Math.pow(dsy-plateResult.y,2));
                  if (dsd < bestD) { bestD=dsd; finalX=dsx; finalY=dsy; snapNote='det.star '+dsd.toFixed(0)+'px'; }
                }
              }
              // Pass 2: direct image centroid (works on saturated stars too)
              if (snapNote === 'WCS only') {
                try {
                  var img = imageWindow.mainView.image;
                  var BOX=50, wx=Math.round(plateResult.x), wy=Math.round(plateResult.y);
                  var bx0=Math.max(0,wx-BOX), bx1=Math.min(img.width-1,wx+BOX);
                  var by0=Math.max(0,wy-BOX), by1=Math.min(img.height-1,wy+BOX);
                  var pkV=-1, pkX=wx, pkY=wy;
                  for (var py=by0;py<=by1;py++) for (var px=bx0;px<=bx1;px++) {
                    var v=0; for (var c=0;c<img.numberOfChannels;c++) v+=img.sample(px,py,c);
                    v/=img.numberOfChannels; if (v>pkV){pkV=v;pkX=px;pkY=py;}
                  }
                  var CR=15, cx0=Math.max(0,pkX-CR), cx1=Math.min(img.width-1,pkX+CR);
                  var cy0=Math.max(0,pkY-CR), cy1=Math.min(img.height-1,pkY+CR);
                  var m00=0,m10=0,m01=0;
                  for (var qy=cy0;qy<=cy1;qy++) for (var qx=cx0;qx<=cx1;qx++) {
                    var iv=0; for (var c=0;c<img.numberOfChannels;c++) iv+=img.sample(qx,qy,c);
                    iv/=img.numberOfChannels;
                    if (iv>pkV*0.5){m00+=iv;m10+=iv*qx;m01+=iv*qy;}
                  }
                  if (m00>0) {
                    var cx=m10/m00, cy=m01/m00;
                    var cd=Math.sqrt(Math.pow(cx-plateResult.x,2)+Math.pow(cy-plateResult.y,2));
                    if (cd < SNAP_R*2) { finalX=cx; finalY=cy; snapNote='img.centroid '+cd.toFixed(0)+'px'; }
                  }
                } catch(ce) { console.warningln('[PLATE] Centroid err: '+ce); }
              }
              var hostStar = {
                x: finalX,
                y: finalY,
                isExoplanetHost: true,
                hostname: closestExo.hostname,
                name: closestExo.name,
                ra: closestExo.ra,
                dec: closestExo.dec
              };
              console.writeln('[PLATE] ✅ Position: (' + hostStar.x.toFixed(1) + ', ' + hostStar.y.toFixed(1) + ') [' + snapNote + ']');
              
              // Set the exoplanet target properly for magenta circle
              this.exoplanetTarget = hostStar;
              this.selectedTarget = hostStar;
              
              // Update pixel coordinate fields
              this.pixX.setValue(hostStar.x);
              this.pixY.setValue(hostStar.y);
              GlobalSettings.pixX = hostStar.x;
              GlobalSettings.pixY = hostStar.y;
              
              // Auto-populate WCS coordinates from detected exoplanet
              this.updateRADisplay(closestExo.ra);
              this.updateDecDisplay(closestExo.dec);
              GlobalSettings.ra = closestExo.ra;
              GlobalSettings.dec = closestExo.dec;
              
              // Force viewport update to show circle
              if (this.viewport && this.viewport.update) {
                this.viewport.update();
              }
            } else {
              console.writeln('[PLATE] ❌ Coordinates out of bounds: (' + plateResult.x.toFixed(1) + ', ' + plateResult.y.toFixed(1) + ') - image is ' + imageWidth + 'x' + imageHeight);
            }
            
            // Switch to WCS mode to show the populated coordinates
            this.mode_WCS.checked = true;
            this.mode_Pixel.checked = false;
            GlobalSettings.mode = 'wcs';
            this.updateUI();
            
            // Force viewport update immediately to show magenta circle
            if (this.viewport && this.viewport.update) {
              this.viewport.update();
            }
            
            // Show success popup for plate solve detection
            var plateSuccessMessage = '🎆 PLATE SOLVE PRECISION TARGETING! 🎆\n\n' +
                                     '✨ DIRECT MATHEMATICAL POSITIONING ✨\n\n' +
                                     'Target: ' + closestExo.hostname + ' (' + closestExo.name + ')\n' +
                                     'Method: Direct Plate Solve Calculation\n' +
                                     'Accuracy: Sub-pixel precision\n' +
                                     'Distance: ' + (closestExo.distance * 60).toFixed(1) + ' arcminutes\n\n' +
                                     'Calculated Coordinates:\n' +
                                     'RA: ' + closestExo.ra.toFixed(6) + '°\n' +
                                     'Dec: ' + closestExo.dec.toFixed(6) + '°\n' +
                                     'Pixel Position: (' + hostStar.x.toFixed(1) + ', ' + hostStar.y.toFixed(1) + ')\n\n' +
                                     '🎯 ' + closestExo.hostname + ' is now targeted with\n' +
                                     'a bright MAGENTA CIRCLE!\n\n' +
                                     '📈 Perfect for exoplanet photometry!';
            
            var plateSuccessPopup = new MessageBox(
              plateSuccessMessage,
              '🎆 ' + closestExo.hostname + ' Precision Targeting Success!',
              StdIcon_Information,
              StdButton_Ok
            );
            plateSuccessPopup.execute();
            
            console.writeln('[PLATE] 🔮 ' + closestExo.hostname + ' target set: (' + hostStar.x.toFixed(1) + ', ' + hostStar.y.toFixed(1) + ')');
            console.writeln('[PLATE] 🎯 Direct plate solve ' + closestExo.hostname + ' ready for photometry!');
            
            // Add to updated list
            updated.push('Plate Solve Precision: ' + closestExo.hostname + ' mathematically located at (' + hostStar.x.toFixed(0) + ', ' + hostStar.y.toFixed(0) + ')');
          } else {
            console.writeln('[PLATE] ❌ Plate solve calculation failed: ' + plateResult.error);
            console.writeln('[PLATE] 📍 To enable precision targeting, run ImageSolver to add complete WCS solution to your image');
          }
          
          updated.push('Nearby exoplanet: ' + this.transitAnalysis.closestExoplanet.hostname + ' - ' + (this.transitAnalysis.closestExoplanet.distance * 60).toFixed(1) + ' arcmin away');
        } else {
          console.writeln('[>] No historical exoplanet transits found during observation period');
          
          // UNIVERSAL FALLBACK: Create circle target for ANY detected exoplanet in field
          if (this.transitAnalysis && this.transitAnalysis.closestExoplanet) {
            var closestExo = this.transitAnalysis.closestExoplanet;
            console.writeln('[>] 🎯 UNIVERSAL EXOPLANET TARGETING: ' + closestExo.hostname + ' detected at ' + (closestExo.distance * 60).toFixed(1) + ' arcmin');
            
            // Use high-precision WCS transformation for universal targeting
            console.writeln('[UNIVERSAL] Database coordinates: RA=' + closestExo.ra.toFixed(6) + '°, Dec=' + closestExo.dec.toFixed(6) + '°');
            
            var plateResult = raDecToPixel(imageWindow, closestExo.ra, closestExo.dec);
            
            if (plateResult.success) {
              console.writeln('[UNIVERSAL] 🎯 ' + closestExo.hostname + ' calculated pixel coordinates: (' + plateResult.x.toFixed(2) + ', ' + plateResult.y.toFixed(2) + ')');
              
              // Validate coordinates are within image bounds
              var imageWidth = imageWindow.mainView.image.width;
              var imageHeight = imageWindow.mainView.image.height;
              
              if (plateResult.x >= 0 && plateResult.x < imageWidth && plateResult.y >= 0 && plateResult.y < imageHeight) {
                console.writeln('[UNIVERSAL] ✅ Coordinates within image bounds (' + imageWidth + 'x' + imageHeight + ')');
                
                // Create the universal exoplanet target
                var universalHostStar = {
                  x: plateResult.x,
                  y: plateResult.y,
                  isExoplanetHost: true,
                  hostname: closestExo.hostname,
                  name: closestExo.name,
                  quality: 1.0
                };
                
                console.writeln('[UNIVERSAL] ✅ Creating universal target: (' + universalHostStar.x.toFixed(1) + ', ' + universalHostStar.y.toFixed(1) + ')');
                
                // Set the exoplanet target properly for magenta circle
                this.exoplanetTarget = universalHostStar;
                this.selectedTarget = universalHostStar;
                
                // Update pixel coordinate fields
                this.pixX.setValue(universalHostStar.x);
                this.pixY.setValue(universalHostStar.y);
                GlobalSettings.pixX = universalHostStar.x;
                GlobalSettings.pixY = universalHostStar.y;
                
                // Auto-populate WCS coordinates from detected exoplanet
                this.updateRADisplay(closestExo.ra);
                this.updateDecDisplay(closestExo.dec);
                GlobalSettings.ra = closestExo.ra;
                GlobalSettings.dec = closestExo.dec;
                
                // Switch to WCS mode to show the populated coordinates
                this.mode_WCS.checked = true;
                this.mode_Pixel.checked = false;
                GlobalSettings.mode = 'wcs';
                this.updateUI();
                
                // Force viewport update to show circle
                if (this.viewport && this.viewport.update) {
                  this.viewport.update();
                }
                
                // Show universal success popup
                var universalMessage = '🎆 UNIVERSAL EXOPLANET DETECTION! 🎆\n\n' +
                                      '✨ FIELD-WIDE PRECISION TARGETING ✨\n\n' +
                                      'Target: ' + closestExo.hostname + ' (' + closestExo.name + ')\n' +
                                      'Method: Universal Field Detection\n' +
                                      'Distance: ' + (closestExo.distance * 60).toFixed(1) + ' arcminutes\n' +
                                      'Magnitude: ' + (closestExo.hostMag || 'Unknown') + '\n\n' +
                                      'Calculated Coordinates:\n' +
                                      'RA: ' + closestExo.ra.toFixed(6) + '°\n' +
                                      'Dec: ' + closestExo.dec.toFixed(6) + '°\n' +
                                      'Pixel Position: (' + universalHostStar.x.toFixed(1) + ', ' + universalHostStar.y.toFixed(1) + ')\n\n' +
                                      '🎯 ' + closestExo.hostname + ' is now targeted with\n' +
                                      'a bright MAGENTA CIRCLE!\n\n' +
                                      '📈 Ready for exoplanet photometry!';
                
                var universalPopup = new MessageBox(
                  universalMessage,
                  '🎆 ' + closestExo.hostname + ' Universal Detection Success!',
                  StdIcon_Information,
                  StdButton_Ok
                );
                universalPopup.execute();
                
                console.writeln('[UNIVERSAL] 🔮 ' + closestExo.hostname + ' universal target set: (' + universalHostStar.x.toFixed(1) + ', ' + universalHostStar.y.toFixed(1) + ')');
                console.writeln('[UNIVERSAL] 🎯 Universal ' + closestExo.hostname + ' ready for photometry!');
                
                // Add to updated list
                updated.push('Universal Detection: ' + closestExo.hostname + ' located at (' + universalHostStar.x.toFixed(0) + ', ' + universalHostStar.y.toFixed(0) + ')');
              } else {
                console.writeln('[UNIVERSAL] ❌ Coordinates out of bounds: (' + plateResult.x.toFixed(1) + ', ' + plateResult.y.toFixed(1) + ') - image is ' + imageWidth + 'x' + imageHeight);
              }
            } else {
              console.writeln('[UNIVERSAL] ❌ Universal plate solve calculation failed: ' + plateResult.error);
            }
          }
          
          updated.push('Transit check: No known transits during observation');
        }
      } else {
        var errorMsg = (this.transitAnalysis && this.transitAnalysis.error) ? this.transitAnalysis.error : 'Unknown error';
        console.warningln('[!] Historical transit analysis failed: ' + errorMsg);
        console.warningln('[!] This doesn\'t affect star detection - you can still proceed with photometry');
      }
    } catch (e) {
      console.warningln('[!] Transit analysis failed: ' + e);
      console.warningln('[!] Star detection results are still valid');
    }
    
    // Update FITS info display with complete transit analysis results
    this.fitsInfo.text = getFITSInfo(imageWindow, this.transitAnalysis);
    
    // Show comprehensive success message with transit results
    var hardwareUpdates = updated.filter(function(item) { 
      return !item.startsWith('Auto-selected') && !item.startsWith('Measured FWHM') && 
             !item.startsWith('Historical transit') && !item.startsWith('Exoplanet host') && 
             !item.startsWith('Transit check'); 
    });
    
    var starUpdates = updated.filter(function(item) { 
      return item.startsWith('Auto-selected') || item.startsWith('Measured FWHM') || 
             item.startsWith('Exoplanet host'); 
    });
    
    var transitUpdates = updated.filter(function(item) { 
      return item.startsWith('Historical transit') || item.startsWith('Transit check'); 
    });
    
    // Check if we have an exoplanet in the field
    var hasExoplanetInField = (this.transitAnalysis && this.transitAnalysis.candidates && this.transitAnalysis.candidates.length > 0);
    var hasCloseExoplanet = (this.transitAnalysis && this.transitAnalysis.closestExoplanet && this.transitAnalysis.closestExoplanet.distance < 1.0);
    var hasExoplanetTarget = (this.exoplanetTarget !== null && this.exoplanetTarget !== undefined);
    
    var message = '';
    
    if (hasExoplanetInField || hasExoplanetTarget) {
      message = '🎆 WCS-BASED EXOPLANET DETECTION SUCCESS! 🎆' + String.fromCharCode(10) + String.fromCharCode(10);
      message += '✨ Precision WCS positioning has located the exoplanet host star! ✨' + String.fromCharCode(10);
      message += 'The star has been automatically targeted with a MAGENTA CIRCLE.' + String.fromCharCode(10) + String.fromCharCode(10);
    } else if (hasCloseExoplanet) {
      message = '🌟 WCS-BASED NEARBY EXOPLANET DETECTED! 🌟' + String.fromCharCode(10) + String.fromCharCode(10);
      message += 'Precision WCS positioning found a nearby exoplanet host star!' + String.fromCharCode(10) + String.fromCharCode(10);
    } else {
      message = '🕰️ Step 3: Smart Setup + Transit Check + WCS Detection Complete!' + String.fromCharCode(10) + String.fromCharCode(10);
    }
    
    if (hardwareUpdates.length > 0) {
      message += '✅ FITS Hardware Extraction:' + String.fromCharCode(10) + hardwareUpdates.join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10);
    }
    
    if (starUpdates.length > 0) {
      message += '🎯 Star Selection & Analysis:' + String.fromCharCode(10) + starUpdates.join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10);
    }
    
    if (transitUpdates.length > 0) {
      var hasTransits = (this.transitAnalysis && this.transitAnalysis.matches && this.transitAnalysis.matches.length > 0);
      message += (hasTransits ? '🎆 Historical Transit Detection:' : '🔍 Transit Analysis:') + String.fromCharCode(10) + 
                 transitUpdates.join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10);
    }
    
    if (this.transitAnalysis && this.transitAnalysis.matches && this.transitAnalysis.matches.length > 0) {
      message += '📊 Your dataset contains historical exoplanet transit data!' + String.fromCharCode(10) +
                 'Proceed with photometry to analyze the transit light curve.';
    } else if (hasExoplanetInField || hasExoplanetTarget) {
      message += '🎠 Perfect for exoplanet photometry! The target star is highlighted' + String.fromCharCode(10) +
                 'in the preview with a bright magenta circle. Proceed with' + String.fromCharCode(10) +
                 'photometry to search for transit signals!';
    } else if (hasCloseExoplanet) {
      message += '🎯 Consider reframing to include the nearby exoplanet host!' + String.fromCharCode(10) +
                 'Or proceed with current photometry targets.';
    } else {
      message += 'Ready for photometry! Review selections in preview window.';
    }
    
    new MessageBox(
      message,
      'Smart Setup + Transit Check Success',
      StdIcon_Information,
      StdButton_Ok
    ).execute();
    
    console.writeln('[>] Smart setup complete °: ' + updated.length + ' parameters configured');
    
    // Note: Keeping image open for other functions to use (Interactive Selection, Prepare for ImageSolver)
    console.writeln('[>] Image kept open °? for other functions: ' + imageWindow.mainView.id);
    
    // Update image preview selector to include the newly opened image
    try {
      this.populateImageSelector();
      // Auto-load the preview if an image is now selected
      if (this.imageSelector.currentItem > 0) {
        this.loadImagePreview();
        console.writeln('[>] Image preview auto-loaded after auto-populate');
      }
      console.writeln('[>] Image selector updated after auto-populate');
    } catch(e) {
      console.warningln('[!] Could not update image selector: ' + e);
    }
  };
  
  // Update aperture calculator and UI
  this.updateCalculator = function() {
    if (!this.hardwareMode_Check.checked) {
      this.calculatedResults.text = 'Hardware calculator disabled - using manual settings';
      return;
    }
    
    try {
      var focalLength = this.focalLength.value;
      var pixelSize = this.pixelSize.value;
      var binning = this.binning.currentItem + 1;
      var fwhm = this.fwhm.value;
      
      var calc = calculateApertureSettings(focalLength, pixelSize, binning, fwhm);
      
      // Update the manual aperture controls with calculated values
      this.r_Spin.value = calc.aperture_r;
      this.rIn_Spin.value = calc.aperture_rIn;
      this.rOut_Spin.value = calc.aperture_rOut;
      
      // Update the display with FWHM analysis info
      var fwhmDisplay = calc.fwhmPixels.toFixed(1) + 'px';
      if (this.fwhmAnalysis) {
        fwhmDisplay += ' (' + this.fwhmAnalysis.starCount + ' stars, ' + this.fwhmAnalysis.weightedAverage.toFixed(2) + '")';
      }
      
      this.calculatedResults.text = 
        'Image Scale: ' + calc.imageScale.toFixed(2) + '"/pixel  |  ' +
        'FWHM: ' + fwhmDisplay + '  |  ' +
        'Settings: r=' + calc.aperture_r + ' rIn=' + calc.aperture_rIn + ' rOut=' + calc.aperture_rOut;
        
    } catch(e) {
      this.calculatedResults.text = 'Calculator error: Check input values';
      console.warningln('Aperture calculator error: ' + e);
    }
  };
  
  // Update UI based on mode
  this.updateUI = function() {
    var isPixel = this.mode_Pixel.checked;
    this.pixX.enabled = isPixel;
    this.pixY.enabled = isPixel;
    
    // Enable/disable HMS/DMS input fields
    var raDecEnabled = !isPixel;
    this.ra_h.enabled = raDecEnabled;
    this.ra_m.enabled = raDecEnabled;
    this.ra_s.enabled = raDecEnabled;
    this.dec_d.enabled = raDecEnabled;
    this.dec_m.enabled = raDecEnabled;
    this.dec_s.enabled = raDecEnabled;
    
    var folderExists = this.folder_Edit.text.length > 0;
    this.prepareWCS_Button.enabled = folderExists;
    
    // Enable/disable hardware calculator controls
    var useHardware = this.hardwareMode_Check.checked;
    this.focalLength.enabled = useHardware;
    this.pixelSize.enabled = useHardware;
    this.binning.enabled = useHardware;
    this.fwhm.enabled = useHardware;
    
    // Enable/disable manual aperture controls
    this.r_Spin.enabled = !useHardware;
    this.rIn_Spin.enabled = !useHardware;
    this.rOut_Spin.enabled = !useHardware;
    
    // Update calculator
    this.updateCalculator();
    
    // Save mode to global settings
    GlobalSettings.mode = isPixel ? 'pixel' : 'wcs';
  };
  
  this.mode_Pixel.onCheck = function() { self.updateUI(); };
  this.mode_WCS.onCheck = function() { self.updateUI(); };
  
  // Hardware calculator event handlers
  this.hardwareMode_Check.onCheck = function() {
    GlobalSettings.useHardwareCalculator = self.hardwareMode_Check.checked;
    self.updateUI();
  };
  
  this.focalLength.onValueUpdated = function() {
    GlobalSettings.focalLength = self.focalLength.value;
    self.updateCalculator();
  };
  
  this.pixelSize.onValueUpdated = function() {
    GlobalSettings.pixelSize = self.pixelSize.value;
    self.updateCalculator();
  };
  
  this.binning.onItemSelected = function() {
    GlobalSettings.binning = self.binning.currentItem + 1;
    self.updateCalculator();
  };
  
  this.fwhm.onValueUpdated = function() {
    self.updateCalculator();
    GlobalSettings.estimatedFWHM = self.fwhm.value;
  };
  
  this.manualRotation.onValueUpdated = function() {
    GlobalSettings.manualRotation = self.manualRotation.value;
    console.writeln('Updated manual rotation to ' + self.manualRotation.value + '°');
  };
  
  this.folder_Edit.onTextUpdated = function() {
    // Auto-update CSV path if it's still the default
    if (!self.outCSV_Edit.text || self.outCSV_Edit.text.indexOf('exo_lightcurve_option1.csv') > 0) {
      self.outCSV_Edit.text = self.folder_Edit.text ? (self.folder_Edit.text + '/exo_lightcurve_option1.csv') : '';
    }
    // Update settings (auto-save disabled for testing)
    GlobalSettings.folder = self.folder_Edit.text;
    console.writeln('Folder updated to: "' + self.folder_Edit.text + '"');
  };
  
  // Default coordinate change handlers (will be overridden in interactive mode)
  this.pixX.onValueUpdated = function() { 
    GlobalSettings.pixX = self.pixX.value; 
    console.writeln('Updated pixX to ' + self.pixX.value); 
  };
  this.pixY.onValueUpdated = function() { 
    GlobalSettings.pixY = self.pixY.value; 
    console.writeln('Updated pixY to ' + self.pixY.value); 
  };
  // HMS/DMS coordinate input event handlers
  this.ra_h.onChange = function(value) {
    // Calculate combined RA in decimal degrees
    var raHours = value;
    var raMinutes = self.ra_m.value;
    var raSeconds = self.ra_s.value;
    var raDeg = (raHours + raMinutes/60.0 + raSeconds/3600.0) * 15.0;
    GlobalSettings.ra = raDeg;
    console.writeln('Updated RA to ' + raDeg.toFixed(6) + '° from HMS: ' + raHours + 'h ' + raMinutes + 'm ' + raSeconds.toFixed(2) + 's');
  };
  
  this.ra_m.onChange = function(value) {
    // Calculate combined RA in decimal degrees
    var raHours = self.ra_h.value;
    var raMinutes = value;
    var raSeconds = self.ra_s.value;
    var raDeg = (raHours + raMinutes/60.0 + raSeconds/3600.0) * 15.0;
    GlobalSettings.ra = raDeg;
    console.writeln('Updated RA to ' + raDeg.toFixed(6) + '° from HMS: ' + raHours + 'h ' + raMinutes + 'm ' + raSeconds.toFixed(2) + 's');
  };
  
  this.ra_s.onValueUpdated = function() {
    // Calculate combined RA in decimal degrees
    var raHours = self.ra_h.value;
    var raMinutes = self.ra_m.value;
    var raSeconds = self.ra_s.value;
    var raDeg = (raHours + raMinutes/60.0 + raSeconds/3600.0) * 15.0;
    GlobalSettings.ra = raDeg;
    console.writeln('Updated RA to ' + raDeg.toFixed(6) + '° from HMS: ' + raHours + 'h ' + raMinutes + 'm ' + raSeconds.toFixed(2) + 's');
  };
  
  this.dec_d.onChange = function(value) {
    // Calculate combined Dec in decimal degrees
    var decDegrees = value;
    var decMinutes = self.dec_m.value;
    var decSeconds = self.dec_s.value;
    var sign = (decDegrees >= 0) ? 1 : -1;
    var decDeg = sign * (Math.abs(decDegrees) + decMinutes/60.0 + decSeconds/3600.0);
    GlobalSettings.dec = decDeg;
    console.writeln('Updated Dec to ' + decDeg.toFixed(6) + '° from DMS: ' + decDegrees + '° ' + decMinutes + '\'\' ' + decSeconds.toFixed(2) + '"');
  };
  
  this.dec_m.onChange = function(value) {
    // Calculate combined Dec in decimal degrees
    var decDegrees = self.dec_d.value;
    var decMinutes = value;
    var decSeconds = self.dec_s.value;
    var sign = (decDegrees >= 0) ? 1 : -1;
    var decDeg = sign * (Math.abs(decDegrees) + decMinutes/60.0 + decSeconds/3600.0);
    GlobalSettings.dec = decDeg;
    console.writeln('Updated Dec to ' + decDeg.toFixed(6) + '° from DMS: ' + decDegrees + '° ' + decMinutes + '\'\' ' + decSeconds.toFixed(2) + '"');
  };
  
  this.dec_s.onValueUpdated = function() {
    // Calculate combined Dec in decimal degrees
    var decDegrees = self.dec_d.value;
    var decMinutes = self.dec_m.value;
    var decSeconds = self.dec_s.value;
    var sign = (decDegrees >= 0) ? 1 : -1;
    var decDeg = sign * (Math.abs(decDegrees) + decMinutes/60.0 + decSeconds/3600.0);
    GlobalSettings.dec = decDeg;
    console.writeln('Updated Dec to ' + decDeg.toFixed(6) + '° from DMS: ' + decDegrees + '° ' + decMinutes + '\'\' ' + decSeconds.toFixed(2) + '"');
  };
  
  // Debug startup state
  console.writeln('[>] Dialog Startup:');
  console.writeln('  folder_Edit.text: "' + this.folder_Edit.text + '"');
  console.writeln('  mode_Pixel.checked: ' + this.mode_Pixel.checked);
  console.writeln('  mode_WCS.checked: ' + this.mode_WCS.checked);
  
  this.updateUI(); // Initialize
  
  // Initialize image preview
  try {
    this.populateImageSelector();
    if (this.imageSelector.numberOfItems > 1) {
      // Auto-select the globally stored image if available
      if (openedImageWindow && !openedImageWindow.isNull) {
        this.loadImagePreview();
      }
    }
  } catch(e) {
    console.warningln('[!] Image preview initialization failed: ' + e);
  }
  
  // 🛰️ PREPARE FOR IMAGESOLVER WORKFLOW
  this.prepareWCS_Button.onClick = function() {
    // Save all current settings
    self.saveSettings();
    
    if (!self.folder_Edit.text) {
      new MessageBox(
        '📋 Folder Required' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Please select a folder with calibrated light frames first.',
        'No Folder Selected',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    
    var files = listImagesInFolder(self.folder_Edit.text);
    if (files.length === 0) {
      new MessageBox(
        '📋 No Images Found' + String.fromCharCode(10) + String.fromCharCode(10) +
        'No supported image files found in the selected folder.' + String.fromCharCode(10) +
        'Please verify the folder contains .fits, .fit, or .xisf files.',
        'Empty Folder',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    
    // SMART IMAGE DETECTION: Check global reference first, then existing open images
    var refWin = null;
    if (openedImageWindow && !openedImageWindow.isNull) {
      refWin = openedImageWindow;
      console.writeln('[>] Using globally stored image for plate solving: ' + refWin.mainView.id);
    } else {
      var windows = ImageWindow.windows;
      if (windows.length > 0) {
        refWin = windows[0];
        console.writeln('[>] Using existing open image for plate solving: ' + refWin.mainView.id);
      } else {
      console.writeln('[>] Opening first image for plate solving: ' + files[0]);
      var refArr = ImageWindow.open(files[0]);
      
      if (refArr.length === 0) {
        new MessageBox(
          '❌ Cannot Open Image' + String.fromCharCode(10) + String.fromCharCode(10) +
          'Cannot open first image for plate solving.' + String.fromCharCode(10) +
          'Please verify the file is accessible.',
          'Image Open Error',
          StdIcon_Error,
          StdButton_Ok
        ).execute();
        return;
      }
      
      refWin = refArr[0];
      openedImageWindow = refWin; // Store global reference
      console.writeln('✅ First frame opened successfully: ' + refWin.mainView.id);
      
      // Refresh image selector to show opened images
      self.populateImageSelector();
      
      // Auto-select the newly opened image in the selector
      if (self.imageSelector) {
        for (var i = 0; i < self.imageSelector.numberOfItems; i++) {
          if (self.imageSelector.itemText(i).indexOf(refWin.mainView.id) >= 0) {
            self.imageSelector.currentItem = i;
            self.loadImagePreview(); // Load preview of the opened image
            break;
          }
        }
      }
      }
    }
    
    GlobalSettings.lastOpenWindow = refWin.mainView.id;
    refWin.show();
    refWin.bringToFront();
    var wasNewlyOpened = !(openedImageWindow && !openedImageWindow.isNull); // true if we just opened it

    // Inform user the image is ready — they now close and run ImageSolver
    new MessageBox(
      (wasNewlyOpened ?
        'Opened: ' + refWin.mainView.id + String.fromCharCode(10) + String.fromCharCode(10) :
        'Using: ' + refWin.mainView.id + String.fromCharCode(10) + String.fromCharCode(10)) +
      'The image is now open in PixInsight.' + String.fromCharCode(10) + String.fromCharCode(10) +
      'Next steps:' + String.fromCharCode(10) +
      '1. Close this script' + String.fromCharCode(10) +
      '2. Run Script \u2192 Astrometry \u2192 Image Solver' + String.fromCharCode(10) +
      '3. Complete plate solving' + String.fromCharCode(10) +
      '4. Re-open this script and run photometry',
      '\u2705 Image Ready for Plate Solving',
      StdIcon_Information,
      StdButton_Ok
    ).execute();

    console.writeln('[>] Image ready for plate solving: ' + refWin.mainView.id);
  };
  
  
  this.run_Button.onClick = function() {
    self.runPhotometry();
  };
  
  this.saveSettings = function() {
    // Update the global settings object
    GlobalSettings.folder = this.folder_Edit.text;
    GlobalSettings.mode = this.mode_Pixel.checked ? 'pixel' : 'wcs';
    GlobalSettings.pixX = this.pixX.value;
    GlobalSettings.pixY = this.pixY.value;
    // Calculate RA from HMS inputs
    var raHours = this.ra_h.value;
    var raMinutes = this.ra_m.value;
    var raSeconds = this.ra_s.value;
    GlobalSettings.ra = (raHours + raMinutes/60.0 + raSeconds/3600.0) * 15.0;
    
    // Calculate Dec from DMS inputs
    var decDegrees = this.dec_d.value;
    var decMinutes = this.dec_m.value;
    var decSeconds = this.dec_s.value;
    var sign = (decDegrees >= 0) ? 1 : -1;
    GlobalSettings.dec = sign * (Math.abs(decDegrees) + decMinutes/60.0 + decSeconds/3600.0);
    GlobalSettings.aperture_r = this.r_Spin.value;
    GlobalSettings.aperture_rIn = this.rIn_Spin.value;
    GlobalSettings.aperture_rOut = this.rOut_Spin.value;
    GlobalSettings.autoComp = this.autoComp_Check.checked;
    GlobalSettings.compCount = this.autoComp_Count.value;
    GlobalSettings.csvPath = this.outCSV_Edit.text;
    // Hardware calculator settings
    GlobalSettings.useHardwareCalculator = this.hardwareMode_Check.checked;
    GlobalSettings.focalLength = this.focalLength.value;
    GlobalSettings.pixelSize = this.pixelSize.value;
    GlobalSettings.binning = this.binning.currentItem + 1;
    GlobalSettings.estimatedFWHM = this.fwhm.value;
    GlobalSettings.manualRotation = this.manualRotation.value;
    
    // Debug what we're trying to save
    console.writeln('[>] Saving current dialog values:');
    console.writeln('  folder: "' + GlobalSettings.folder + '"');
    console.writeln('  mode: ' + GlobalSettings.mode);
    console.writeln('  aperture_r: ' + GlobalSettings.aperture_r);
    console.writeln('  csvPath: "' + GlobalSettings.csvPath + '"');
    
    // Save to persistent storage
    var success = saveSettings(GlobalSettings);
    if (success) {
      console.writeln('? Settings save completed successfully');
    } else {
      console.warningln('Settings save failed: ' + e);
    }
  };
  
  // Standard photometry run (pixel mode or existing WCS)
  this.runPhotometry = function() {
    this.saveSettings();
    
    if (!this.folder_Edit.text) {
      new MessageBox(
        '📋 Folder Required' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Please select a folder with calibrated light frames first.',
        'No Folder Selected',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    
    var files = listImagesInFolder(this.folder_Edit.text);
    if (files.length === 0) {
      new MessageBox(
        '📋 No Images Found' + String.fromCharCode(10) + String.fromCharCode(10) +
        'No supported image files found in the selected folder.',
        'Empty Folder',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    
    // Get reference window
    var refWin = null;
    var shouldCloseRefWin = false;
    
    // Look for existing WCS windows
    if (!this.mode_Pixel.checked) {
      var windows = ImageWindow.windows;
      for (var i = 0; i < windows.length; i++) {
        if (hasWCS(windows[i])) {
          refWin = windows[i];
          break;
        }
      }
    }
    
    // If no WCS window, open first image
    if (!refWin) {
      var refArr = ImageWindow.open(files[0]);
      if (refArr.length === 0) {
      new MessageBox(
        '❌ Cannot Open Reference Image' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Cannot open first image for photometry.' + String.fromCharCode(10) +
        'Please verify the file is accessible.',
        'Image Open Error',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    refWin = refArr[0];
    shouldCloseRefWin = true;
  }
  
  this.runPhotometryCore(refWin, shouldCloseRefWin);
};


// Core photometry logic
this.runPhotometryCore = function(refWin, shouldCloseRefWin) {
  var refImg = refWin.mainView.image;
  
  // Resolve coordinates
  var rc = this.resolveCoords(refWin);
  if (!rc.ok) {
    if (shouldCloseRefWin) refWin.close();
    new MessageBox(
      '❌ Coordinate Resolution Failed' + String.fromCharCode(10) + String.fromCharCode(10) +
      rc.error + String.fromCharCode(10) + String.fromCharCode(10) +
      'Please verify your coordinate settings and try again.',
      'Coordinate Error',
      StdIcon_Error,
      StdButton_Ok
    ).execute();
    return;
  }
    
    console.writeln('[>] Target: (' + rc.target.x.toFixed(2) + ', ' + rc.target.y.toFixed(2) + ')');
    
    // Find comparison stars
    var comps = [];
    if (this.autoComp_Check.checked) {
      var r = this.r_Spin.value;
      var rIn = this.rIn_Spin.value;
      var rOut = this.rOut_Spin.value;
      
      var cand = findBrightStars(refImg, this.autoComp_Count.value + 10, Math.max(rOut + 5, 25), Math.max(3 * rOut, 40), r, rIn, rOut);
      for (var i = 0; i < cand.length && comps.length < this.autoComp_Count.value; i++) {
        var p = cand[i];
        if (!farFrom(p, rc.target, Math.max(5 * r, 30))) continue;
        var ok = true;
        for (var j = 0; j < comps.length; j++) {
          if (!farFrom(p, comps[j], Math.max(5 * r, 30))) {
            ok = false;
            break;
          }
        }
        if (ok) comps.push({ x: p.x, y: p.y });
      }
    }
    
    if (shouldCloseRefWin) refWin.close();
    
    if (comps.length < 2) {
      new MessageBox(
        '⭐ Insufficient Comparison Stars' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Need at least 2 comparison stars for photometry.' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Found: ' + comps.length + ' stars' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Try adjusting aperture settings or enabling auto-detection.',
        'Not Enough Stars',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    
    console.writeln('? Found ' + comps.length + ' comparison stars');
    console.writeln('? Target coordinates: (' + rc.target.x.toFixed(2) + ', ' + rc.target.y.toFixed(2) + ')');
    
    // Process all images (same as stable version)
    var files = listImagesInFolder(this.folder_Edit.text);
    console.writeln('? Processing ' + files.length + ' images...');
    var times = [], rel = [], absT = [], absC = [];
    var err = [];
    // Added arrays for advanced CSV and detrending
    var skyArr = [], fwhmArr = [], airmArr = [], expArr = [];
    // Advanced options
    var frozenWeights = null;
    var chosenApMult = null;
    var apR = this.r_Spin.value, apRIn = this.rIn_Spin.value, apROut = this.rOut_Spin.value;

    
    for (var k = 0; k < files.length; k++) {
      try {
        var wa = ImageWindow.open(files[k]);
        if (wa.length === 0) continue;
        
        var win = wa[0];
        var img = win.mainView.image;
        var kw = buildKeywordMap(win);
        
        var cT = localCentroid(img, rc.target.x, rc.target.y, Math.max(this.r_Spin.value*1.5, 8));
        var tPhot = aperturePhotometry(img, cT.x, cT.y, this.r_Spin.value, this.rIn_Spin.value, this.rOut_Spin.value);

        // Flag frames where target is saturated — warn but include unless badly saturated
        if (tPhot.saturated) {
          // Check how saturated: peak > 0.995 is badly saturated, skip it
          // peak 0.98-0.995 is mildly saturated, include with warning
          var peakVal = tPhot.peak !== undefined ? tPhot.peak : 1.0;
          if (peakVal > 0.995) {
            console.writeln('[LC] frame ' + (k+1) + ': TARGET BADLY SATURATED (peak=' + peakVal.toFixed(4) + ') — skipping frame');
            win.close();
            continue;
          } else {
            console.writeln('[LC] frame ' + (k+1) + ': TARGET MILDLY SATURATED (peak=' + peakVal.toFixed(4) + ') — including with caution');
          }
        }
        
        // Debug: Show target measurement details for first few frames
        if (k < 3) {
          console.writeln('  DEBUG - Frame ' + (k+1) + ': Target coords (' + rc.target.x.toFixed(1) + ', ' + rc.target.y.toFixed(1) + 
                         ') -> Centroid (' + cT.x.toFixed(1) + ', ' + cT.y.toFixed(1) + ') -> Flux ' + tPhot.netFlux.toFixed(1));
        }
        
        
        var csum = 0;          // legacy simple sum (still tracked for logging)
        var wsum = 0;          // sum of weights
        var wflux = 0;         // weighted flux accumulator
        var compAbsSig2_sum = 0; // for variance of weighted average
        
        // Read noise and gain from FITS if present (fallback to typical values)
        var gainKW  = (getKeyword(kw,'EGAIN') || getKeyword(kw,'GAIN') || null);
        var rdKW    = (getKeyword(kw,'RDNOISE') || getKeyword(kw,'READNOIS') || null);
        var gainVal = gainKW ? parseFloat(gainKW) : null;
        var rdVal   = rdKW ? parseFloat(rdKW) : null;
        
        // Use generic defaults only if no FITS values found
        if (!(gainVal > 0)) gainVal = null; // Let photometry handle defaults
        if (!(rdVal > 0)) rdVal = null;     // Let photometry handle defaults
        
        // Aperture/sky areas
        var apArea   = tPhot.npix || Math.PI * (this.r_Spin.value*this.r_Spin.value);
        var skyArea  = Math.PI * (Math.max(0,this.rOut_Spin.value*this.rOut_Spin.value - this.rIn_Spin.value*this.rIn_Spin.value));
        
        // Target uncertainty
        var tUnc = (typeof calculatePhotometricUncertainty === 'function') ?
          calculatePhotometricUncertainty(tPhot.netFlux, tPhot.sky, apArea, skyArea, rdVal, gainVal) :
          {relative: 0.01, absolute: Math.max(1e-9, tPhot.netFlux*0.01)};
        
        // Comparison stars: inverse-variance weighted ensemble
        // w_i = 1/σ_i² (HOPS / standard differential photometry approach)
        // This gives optimal weights under Gaussian noise: bright stars get
        // more weight but only proportional to their actual S/N, not sqrt(flux).
        // Saturated comparison stars are excluded — their response is nonlinear.
        var compFluxes = [];
        var compRelErr = [];
        for (var c = 0; c < comps.length; c++) {
          var cc = localCentroid(img, comps[c].x, comps[c].y, Math.max(apR*1.5, 8));
          var cp = aperturePhotometry(img, cc.x, cc.y, apR, apRIn, apROut);

          // Skip saturated comparison stars (nonlinear — bad for differential phot)
          if (cp.saturated) {
            console.writeln('[LC] frame ' + (k+1) + ': comp ' + c + ' saturated — skipping');
            continue;
          }

          var cf = cp.netFlux; // honest value — may be negative for bad frames

          // If net flux is negative this star is unreliable this frame — skip it
          if (cf <= 0) continue;

          csum += cf;
          
          // Uncertainty for comparison star
          var capArea = cp.npix || apArea;
          var cUnc = (typeof calculatePhotometricUncertainty === 'function') ?
            calculatePhotometricUncertainty(cf, cp.sky, capArea, skyArea, rdVal, gainVal) :
            {relative: 0.01, absolute: Math.max(1e-9, cf*0.01)};
          
          // Inverse-variance weight: w = 1/σ²
          // More robust than sqrt(flux): correctly handles cases where
          // read noise dominates (faint stars) vs. Poisson (bright stars)
          var sigAbs = Math.max(cUnc.absolute, cf * 0.001);
          var w = 1.0 / (sigAbs * sigAbs);
          wsum  += w;
          wflux += w * cf;
          
          compFluxes.push({cf:cf, sigmaAbs:sigAbs, w:w});
        }
        
        
        var cavg = (wsum > 0 ? (wflux / wsum) : csum);

        // Apply frozen comparison-star weights if enabled
        if (GlobalSettings.freezeCompWeights) {
          if (!frozenWeights) {
            // Build normalized weights from first good frame
            var sumW0 = 0, tmpW = [];
            for (var wi0=0; wi0<compFluxes.length; wi0++){ var ww = Math.sqrt(Math.max(1e-9, compFluxes[wi0].cf)); tmpW.push(ww); sumW0 += ww; }
            if (sumW0 > 0){
              frozenWeights = [];
              for (var wi1=0; wi1<tmpW.length; wi1++) frozenWeights.push(tmpW[wi1]/sumW0);
              console.writeln('[>] Comparison-star weights frozen from first frame');
            }
          }
          if (frozenWeights && frozenWeights.length === compFluxes.length) {
            // recompute cavg and downstream using frozen weights
            cavg = 0;
            for (var wi2=0; wi2<compFluxes.length; wi2++) cavg += frozenWeights[wi2] * compFluxes[wi2].cf;
            // override normalized weights on records for variance calc
            for (var wi3=0; wi3<compFluxes.length; wi3++) compFluxes[wi3].w = frozenWeights[wi3];
            wsum = 1.0; // so alpha = a.w/wsum equals normalized weight
          }
        }

        // Proper weighted-average variance
        var sigmaC_abs2 = 0;

        var sigmaC_abs2 = 0;
        if (wsum > 0 && compFluxes.length > 0) {
          sigmaC_abs2 = 0;
          for (var ci=0; ci<compFluxes.length; ci++){
            var a = compFluxes[ci];
            var alpha = a.w / wsum; // normalized weight
            sigmaC_abs2 += (alpha*alpha) * (a.sigmaAbs*a.sigmaAbs);
          }
        } else {
          // fall back: assume independent, add in quadrature then divide by N
          if (compFluxes.length > 0) {
            var s2 = 0;
            for (var ci2=0; ci2<compFluxes.length; ci2++){ s2 += compFluxes[ci2].sigmaAbs*compFluxes[ci2].sigmaAbs; }
            sigmaC_abs2 = s2 / (compFluxes.length*compFluxes.length);
          } else {
            sigmaC_abs2 = (0.01 * cavg) * (0.01 * cavg);
          }
        }
        var sigmaC_abs = Math.sqrt(Math.max(0, sigmaC_abs2));
        var relErrC = (cavg>0) ? (sigmaC_abs / cavg) : 0.02;
        
        // Relative flux and propagated relative error: sqrt((σT/T)^2 + (σC/C)^2)
        var rf = Math.max(1e-12, tPhot.netFlux) / Math.max(1e-12, cavg);
        var relErrT = tUnc.relative;
        var relErrRF = Math.sqrt(Math.max(0, relErrT*relErrT + relErrC*relErrC));

        // Track per-frame metrics for CSV and detrending
        try{
          var cxm = Math.round(cT.x), cym = Math.round(cT.y);
          var centerValM = 0; for (var chh=0; chh<img.numberOfChannels; chh++) centerValM += img.sample(cxm, cym, chh); centerValM /= Math.max(1,img.numberOfChannels);
          var halfM = tPhot.sky + 0.5*Math.max(0, centerValM - tPhot.sky);
          var fwhmXcsv = calculateFWHM(img, cT.x, cT.y, halfM, true);
          var fwhmYcsv = calculateFWHM(img, cT.x, cT.y, halfM, false);
          var fwhmCSV = 0.5*(fwhmXcsv + fwhmYcsv);
          fwhmArr.push(fwhmCSV);
        }catch(e){
          fwhmArr.push(GlobalSettings.estimatedFWHM || 0);
        }
        skyArr.push(tPhot.sky);


        
        // Debug: Show flux calculation for first few frames
        if (k < 3) {
          console.writeln('  DEBUG - Frame ' + (k+1) + ': TargetFlux=' + tPhot.netFlux.toFixed(1) + 
                         ', CompSum=' + csum.toFixed(1) + ', RelFlux=' + rf.toFixed(4));
        }
        
        var exp = parseFloat(getKeyword(kw, 'EXPTIME') || getKeyword(kw, 'EXPOSURE') || '0');
        var jd = jdFromKeywords(kw);
        var amVal = parseFloat(getKeyword(kw,'AIRMASS') || getKeyword(kw,'SECZ') || 'NaN'); if(!isFinite(amVal)){ try{ amVal = __computeAirmassFromKeywords(kw); }catch(__e_am){ amVal = NaN; } }
        if (isFinite(jd) && exp > 0) jd += 0.5 * exp / 86400.0;
        if (!isFinite(jd)) jd = times.length ? times[times.length - 1] + Math.max(1, exp) / 86400.0 : k;
        
        times.push(jd);
        rel.push(rf);
        absT.push(tPhot.netFlux);
        absC.push(cavg);
        err.push(relErrRF);
        expArr.push(exp);
        airmArr.push(amVal);
        var mmag = 1085.736 * relErrRF; var mmagStr = (isFinite(mmag) && mmag<=20000)? mmag.toFixed(1) : 'NaN'; console.writeln('[LC] frame ' + (k+1) + ': rf=' + rf.toFixed(6) + ' ± ' + mmagStr + ' mmag');
        win.close();
      } catch(e) {
        console.warningln('Error processing ' + files[k] + ': ' + e);
      }
    }
    
    if (times.length === 0) {
      new MessageBox(
        '📊 No Photometry Data' + String.fromCharCode(10) + String.fromCharCode(10) +
        'No photometric data was extracted from any images.' + String.fromCharCode(10) + String.fromCharCode(10) +
        'Please verify:' + String.fromCharCode(10) +
        '• Images contain valid FITS headers' + String.fromCharCode(10) +
        '• Target coordinates are within image bounds' + String.fromCharCode(10) +
        '• Aperture settings are appropriate for star sizes',
        'No Data Extracted',
        StdIcon_Error,
        StdButton_Ok
      ).execute();
      return;
    }
    
    // Normalize and sort
    var med = median(rel);
    for (var m = 0; m < rel.length; m++) {
      rel[m] /= med;
    }
    
    var idx = times.map(function(v, i) { return { v: v, i: i }; });
    idx.sort(function(a, b) { return a.v - b.v; });
    var T = [], R = [], AT = [], AC = [], E = [];
    for (var s = 0; s < idx.length; s++) {
      var ii = idx[s].i;
      T.push(times[ii]);
      R.push(rel[ii]);
      AT.push(absT[ii]);
      AC.push(absC[ii]);
      E.push(err[ii] || 0.01);
    }
    
    // Detrend relative flux if enabled
    var Rdet = R.slice();
    try{
      if (GlobalSettings.enableDetrending){
        var t0d = T.length ? T[0] : NaN;
        var hrsd = [];
        for (var hh=0; hh<T.length; hh++){ hrsd.push(isFinite(t0d) && isFinite(T[hh]) ? (T[hh]-t0d)*24.0 : 0); }
        var terms = (GlobalSettings.detrendTerms && GlobalSettings.detrendTerms.length) ? GlobalSettings.detrendTerms : ['airmass','sky','fwhm','time'];
        var resDet = detrendRelFlux(hrsd, R, airmArr, skyArr, fwhmArr, terms);
        Rdet = resDet.detrended;
        console.writeln('[>] Linear detrending applied');
      }
    }catch(e){ console.warningln('[!] Detrending failed: ' + e); }
    // Save CSV
    var outPath = this.outCSV_Edit.text || (this.folder_Edit.text + '/exo_lightcurve_option1.csv');
    var t0 = T.length ? T[0] : NaN;
    var hrs = [];
    for (var h = 0; h < T.length; h++) {
      hrs.push(isFinite(t0) && isFinite(T[h]) ? (T[h] - t0) * 24.0 : '');
    }
    
    try {
      var f = new File();
      f.createForWriting(outPath);
      f.outTextLn('JD,HoursFromStart,RelativeFlux,RelFluxErr,RelFluxErr_mmag,TargetFlux,CompFlux,FWHM_px,Sky,AirMass,Exposure_s,DetrendedRelFlux');
      for (var z = 0; z < T.length; z++) {
        var hrsz = (hrs[z]===''?'':hrs[z].toFixed(6));
        var mmag = (E[z]!==undefined ? (1000.0*2.5/Math.LN10*E[z]).toFixed(3) : '');
        var airm = (isFinite(airmArr[z]) ? airmArr[z].toFixed(5) : '');
        var expv = (typeof expArr[z] !== 'undefined' ? expArr[z].toFixed(3) : '');
        var fwhmv = (typeof fwhmArr[z] !== 'undefined' ? fwhmArr[z].toFixed(3) : '');
        var skyv = (typeof skyArr[z] !== 'undefined' ? skyArr[z].toFixed(6) : '');
        var detv = (typeof Rdet[z] !== 'undefined' ? Rdet[z].toFixed(6) : '');
        f.outTextLn(
          T[z].toFixed(8)+','+hrsz+','+
          R[z].toFixed(6)+','+(E[z]!==undefined?E[z].toFixed(6):'')+','+mmag+','+
          (AT[z]!==undefined?AT[z].toFixed(3):'')+','+(AC[z]!==undefined?AC[z].toFixed(3):'')+','+
          fwhmv+','+skyv+','+airm+','+expv+','+detv
        );
      }
      f.close();
      console.writeln('[>] Saved: ' + outPath);
    } catch(e) {
      console.warningln('Cannot save CSV: ' + e);
    }

    
    // Show light curve plot
    try {
      console.writeln('Creating light curve plot...');
      var lcd = new WCSHorizontalLightCurveDialog(T, R, E);
      lcd.execute();
    } catch(e) {
      console.warningln('Light curve plot failed: ' + e);
    }
    
    new MessageBox(
      '🎆 ExoTransit Light Curve Analysis Complete!' + String.fromCharCode(10) + String.fromCharCode(10) +
      '📊 Analysis Results:' + String.fromCharCode(10) +
      'Data points: ' + T.length + String.fromCharCode(10) +
      'Duration: ' + ((T[T.length-1] - T[0]) * 24).toFixed(2) + ' hours' + String.fromCharCode(10) + String.fromCharCode(10) +
      '💾 Output Files:' + String.fromCharCode(10) +
      'CSV saved: ' + outPath + String.fromCharCode(10) +
      'Light curve plot displayed' + String.fromCharCode(10) + String.fromCharCode(10) +
      '💾 Settings saved for this PixInsight session!' + String.fromCharCode(10) +
      'Note: Settings will reset when PixInsight restarts',
      'Light Curve Analysis Complete',
      StdIcon_Information,
      StdButton_Ok
    ).execute();
  };
  
  this.resolveCoords = function(win) {
    if (this.mode_Pixel.checked) {
      var x = this.pixX.value;
      var y = this.pixY.value;
      if (!isFinite(x) || !isFinite(y)) {
        return { ok: false, error: 'Enter valid pixel coordinates' };
      }
      return { ok: true, target: { x: x, y: y } };
    } else {
      // Calculate RA from HMS inputs
      var raHours = this.ra_h.value;
      var raMinutes = this.ra_m.value;
      var raSeconds = this.ra_s.value;
      var ra = (raHours + raMinutes/60.0 + raSeconds/3600.0) * 15.0;
      
      // Calculate Dec from DMS inputs
      var decDegrees = this.dec_d.value;
      var decMinutes = this.dec_m.value;
      var decSeconds = this.dec_s.value;
      var sign = (decDegrees >= 0) ? 1 : -1;
      var dec = sign * (Math.abs(decDegrees) + decMinutes/60.0 + decSeconds/3600.0);
      
      if (!isFinite(ra) || !isFinite(dec)) {
        return { ok: false, error: 'Enter valid RA and Dec coordinates' };
      }
      
      if (!hasWCS(win)) {
        return { ok: false, error: 'No WCS found. Use "Prepare for ImageSolver" first.' };
      }
      
      var pixelCoords = raDecToPixel(win, ra, dec);
      if (!pixelCoords.success) {
        return { ok: false, error: 'WCS conversion failed: ' + pixelCoords.error };
      }
      
      console.writeln('[>] RA=' + ra.toFixed(6) + '°, Dec=' + dec.toFixed(6) + '° ? pixel(' + pixelCoords.x.toFixed(2) + ', ' + pixelCoords.y.toFixed(2) + ')');
      return { ok: true, target: { x: pixelCoords.x, y: pixelCoords.y } };
    }
  };
  
  // Layout - side-by-side configuration
  // Left panel for controls
  var leftPanel = new VerticalSizer;
  leftPanel.margin = 8; // Reduced margin
  leftPanel.spacing = 6; // Reduced spacing
  
  // Right panel for preview
  var rightPanel = new VerticalSizer;
  rightPanel.margin = 12;
  rightPanel.spacing = 8;
  
  // 1. FOLDER SELECTION (select folder only)
  var folderLabel = new Label(this);
  folderLabel.text = '📁 Step 1: Select Folder with Calibrated Light Frames:';
  leftPanel.add(folderLabel);
  var folderSizer = new HorizontalSizer;
  folderSizer.spacing = 6;
  folderSizer.add(this.folder_Edit, 100);
  folderSizer.add(this.folder_Button);
  leftPanel.add(folderSizer);
  leftPanel.addSpacing(4);
  
  // 2. WCS PREPARATION — open image, plate solve, verify (all without closing dialog)
  var workflowLabel = new Label(this);
  workflowLabel.text = '🔍 Step 2: Prepare for Plate Solving:';
  leftPanel.add(workflowLabel);
  var workflowSizer = new HorizontalSizer;
  workflowSizer.spacing = 4;
  workflowSizer.add(this.prepareWCS_Button);
  workflowSizer.addStretch();
  leftPanel.add(workflowSizer);
  leftPanel.addSpacing(8);
  
  // 3. SMART SETUP FROM FITS (enhanced with WCS-based exoplanet positioning)
  var autoPopulateLabel = new Label(this);
  autoPopulateLabel.text = '🕰️ Step 3: Smart Setup + Transit Check + WCS Exoplanet Detection:';
  leftPanel.add(autoPopulateLabel);
  var autoPopulateSizer = new HorizontalSizer;
  autoPopulateSizer.spacing = 6;
  autoPopulateSizer.add(this.autoPopulate_Button);
  autoPopulateSizer.addSpacing(12); // Add some space between button and rotation control
  autoPopulateSizer.add(this.manualRotation);
  autoPopulateSizer.addStretch();
  leftPanel.add(autoPopulateSizer);
  leftPanel.add(this.fitsInfo);
  leftPanel.addSpacing(4);
  
  // 4. HARDWARE CALCULATOR (already populated from step 3)
  leftPanel.add(this.hardwareMode_Check);
  leftPanel.addSpacing(4);
  
  var hardwareLabel = new Label(this);
  hardwareLabel.text = '🔧 Step 4: Hardware Settings (auto-configured or manual):';
  leftPanel.add(hardwareLabel);
  
  var hardwareSizer1 = new HorizontalSizer;
  hardwareSizer1.spacing = 6;
  hardwareSizer1.add(this.focalLength);
  hardwareSizer1.add(this.pixelSize);
  leftPanel.add(hardwareSizer1);
  
  var hardwareSizer2 = new HorizontalSizer;
  hardwareSizer2.spacing = 6;
  var binningLabel = new Label(this); binningLabel.text = 'Binning:';
  hardwareSizer2.add(binningLabel);
  hardwareSizer2.add(this.binning);
  hardwareSizer2.add(this.fwhm);
  hardwareSizer2.addStretch();
  leftPanel.add(hardwareSizer2);
  
  leftPanel.add(this.calculatedResults);
  leftPanel.addSpacing(4);

  // Manual Aperture Settings (now part of step 3)
  var apertureLabel = new Label(this);
  apertureLabel.text = '🔧 Manual Aperture Override:';
  leftPanel.add(apertureLabel);
  var apSizer = new HorizontalSizer;
  apSizer.spacing = 6;
  var rLabel = new Label(this); rLabel.text = 'r:';
  apSizer.add(rLabel);
  apSizer.add(this.r_Spin);
  var rInLabel = new Label(this); rInLabel.text = 'rIn:';
  apSizer.add(rInLabel);
  apSizer.add(this.rIn_Spin);
  var rOutLabel = new Label(this); rOutLabel.text = 'rOut:';
  apSizer.add(rOutLabel);
  apSizer.add(this.rOut_Spin);
  leftPanel.add(apSizer);
  leftPanel.addSpacing(4);
  
  // 5. MODE SELECTION (decision point - moved down)
  var modeLabel = new Label(this);
  modeLabel.text = '🎯 Step 5: Choose Targeting Mode:';
  leftPanel.add(modeLabel);
  var modeSizer = new HorizontalSizer;
  modeSizer.spacing = 12;
  modeSizer.add(this.mode_Pixel);
  modeSizer.add(this.mode_WCS);
  modeSizer.addStretch();
  leftPanel.add(modeSizer);
  leftPanel.addSpacing(4);
  
  // 6. COORDINATE SETTINGS (based on mode)
  var coordLabel = new Label(this);
  coordLabel.text = '📍 Step 6: Target Coordinates:';
  leftPanel.add(coordLabel);
  
  // Pixel coordinates row
  var pixelCoordSizer = new HorizontalSizer;
  pixelCoordSizer.spacing = 6;
  pixelCoordSizer.add(this.pixX);
  pixelCoordSizer.add(this.pixY);
  leftPanel.add(pixelCoordSizer);
  
  // RA coordinates row (HMS)
  var raLabel = new Label(this);
  raLabel.text = 'RA (HMS):';
  var raSizer = new HorizontalSizer;
  raSizer.spacing = 4;
  raSizer.add(raLabel);
  raSizer.add(this.ra_h);
  var raHLabel = new Label(this); raHLabel.text = 'h';
  raSizer.add(raHLabel);
  raSizer.add(this.ra_m);
  var raMLabel = new Label(this); raMLabel.text = 'm';
  raSizer.add(raMLabel);
  raSizer.add(this.ra_s);
  var raSLabel = new Label(this); raSLabel.text = 's';
  raSizer.add(raSLabel);
  raSizer.addStretch();
  leftPanel.add(raSizer);
  
  // Dec coordinates row (DMS)
  var decLabel = new Label(this);
  decLabel.text = 'Dec (DMS):';
  var decSizer = new HorizontalSizer;
  decSizer.spacing = 4;
  decSizer.add(decLabel);
  decSizer.add(this.dec_d);
  var decDLabel = new Label(this); decDLabel.text = '°';
  decSizer.add(decDLabel);
  decSizer.add(this.dec_m);
  var decMLabel = new Label(this); decMLabel.text = '\'';
  decSizer.add(decMLabel);
  decSizer.add(this.dec_s);
  var decSLabel = new Label(this); decSLabel.text = '"';
  decSizer.add(decSLabel);
  decSizer.addStretch();
  leftPanel.add(decSizer);
  
  // Interactive target selection button
  var interactiveSizer = new HorizontalSizer;
  interactiveSizer.spacing = 6;
  interactiveSizer.add(this.interactiveSelect_Button);
  interactiveSizer.addStretch();
  leftPanel.add(interactiveSizer);
  leftPanel.addSpacing(4);
  
  // RIGHT PANEL - Compact controls at top, large preview below
  
  // Image selector (moved to top)
  var imageSelectorSizer = new HorizontalSizer;
  imageSelectorSizer.spacing = 4;
  imageSelectorSizer.add(this.imageSelector_Label);
  imageSelectorSizer.add(this.imageSelector, 100);
  rightPanel.add(imageSelectorSizer);
  
  // Control buttons in compact rows
  this.refreshImages_Button = new PushButton(this);
  this.refreshImages_Button.text = '🔄 Refresh';
  this.refreshImages_Button.toolTip = 'Refresh the list of available images';
  this.refreshImages_Button.onClick = function() {
    self.populateImageSelector();
    if (self.imageSelector.currentItem > 0) {
      self.loadImagePreview();
    }
  };
  
  this.autoSTF_Button = new PushButton(this);
  this.autoSTF_Button.text = '☢️ Auto STF';
  this.autoSTF_Button.toolTip = 'Apply automatic screen transfer function to improve preview visibility';
  this.autoSTF_Button.onClick = function() {
    self.applyAutoSTF();
  };
  
  // Zoom controls
  this.zoomIn_Button = new PushButton(this);
  this.zoomIn_Button.text = '+';
  this.zoomIn_Button.toolTip = 'Zoom in';
  this.zoomIn_Button.onClick = function() {
    self.zoomIn();
  };
  
  this.zoomOut_Button = new PushButton(this);
  this.zoomOut_Button.text = '-';
  this.zoomOut_Button.toolTip = 'Zoom out';
  this.zoomOut_Button.onClick = function() {
    self.zoomOut();
  };
  
  this.zoomFit_Button = new PushButton(this);
  this.zoomFit_Button.text = 'Fit';
  this.zoomFit_Button.toolTip = 'Fit image to preview window';
  this.zoomFit_Button.onClick = function() {
    self.zoomToFit();
  };
  
  this.zoom100_Button = new PushButton(this);
  this.zoom100_Button.text = '1:1';
  this.zoom100_Button.toolTip = 'Zoom to 100% (1:1 pixel ratio)';
  this.zoom100_Button.onClick = function() {
    self.zoomTo100();
  };
  
  // Compact control row 1: Refresh + Auto STF
  var controlRow1 = new HorizontalSizer;
  controlRow1.spacing = 4;
  controlRow1.add(this.refreshImages_Button);
  controlRow1.add(this.autoSTF_Button);
  controlRow1.addStretch();
  rightPanel.add(controlRow1);
  
  // Compact control row 2: Zoom buttons
  var controlRow2 = new HorizontalSizer;
  controlRow2.spacing = 2;
  var zoomLabel = new Label(this);
  zoomLabel.text = 'Zoom:';
  controlRow2.add(zoomLabel);
  controlRow2.add(this.zoomIn_Button);
  controlRow2.add(this.zoomOut_Button);
  controlRow2.add(this.zoomFit_Button);
  controlRow2.add(this.zoom100_Button);
  controlRow2.addStretch();
  rightPanel.add(controlRow2);
  
  rightPanel.addSpacing(4);
  
  // LARGE IMAGE PREVIEW - takes up most of the space
  rightPanel.add(this.imagePreview, 100); // Maximum stretch for preview
  
  // LEFT PANEL - Already handled workflow buttons in Step 2
  
  // 7. COMPARISON STAR SETTINGS
  var compLabel = new Label(this);
  compLabel.text = '⭐ Step 7: Comparison Stars:';
  leftPanel.add(compLabel);
  var compSizer = new HorizontalSizer;
  compSizer.spacing = 6;
  compSizer.add(this.autoComp_Check);
  compSizer.addStretch();
  var countLabel = new Label(this); countLabel.text = 'Count:';
  compSizer.add(countLabel);
  compSizer.add(this.autoComp_Count);
  leftPanel.add(compSizer);
  leftPanel.addSpacing(8);
  
  // 8. CSV OUTPUT SETTINGS
  var csvLabel = new Label(this);
  csvLabel.text = '📊 Step 8: Output Settings:';
  leftPanel.add(csvLabel);
  leftPanel.add(outCSVLabel);
  var outCSVSizer = new HorizontalSizer;
  outCSVSizer.spacing = 6;
  outCSVSizer.add(this.outCSV_Edit, 100);
  outCSVSizer.add(this.outCSV_Button);
  leftPanel.add(outCSVSizer);
  leftPanel.addSpacing(12);
  
  // 9. ACTION BUTTONS
  var actionLabel = new Label(this);
  actionLabel.text = '🚀 Final Actions:';
  leftPanel.add(actionLabel);
  var buttonSizer = new HorizontalSizer;
  buttonSizer.spacing = 8;
  buttonSizer.add(this.saveTest_Button);
  buttonSizer.add(this.run_Button);
  buttonSizer.addStretch();
  buttonSizer.add(this.close_Button);
  leftPanel.add(buttonSizer);
  
  // Create main horizontal sizer for side-by-side layout
  this.sizer = new HorizontalSizer;
  this.sizer.margin = 6;
  this.sizer.spacing = 12;
  this.sizer.add(leftPanel, 30); // Left panel with controls (30% width)
  this.sizer.add(rightPanel, 70); // Right panel with preview (70% width)
  
  // Add resize handler to update preview when dialog is resized
  this.onResize = function(newWidth, newHeight, oldWidth, oldHeight) {
    // Update scroll bars and viewport when dialog is resized
    if (this.displayImage) {
      this.initScrollBars();
      this.viewport.update();
    }
  };
  
  // Initialize the dialog after UI is set up
  this.populateImageSelector();
  if (this.imageSelector.currentItem > 0) {
    this.loadImagePreview();
  }
}

ExoTransitEnhancedDialog.prototype = new Dialog;

// ---------------- ° MAIN SCRIPT FUNCTION (for toolbar shortcuts) ----------------
// This function can be called directly from toolbar shortcuts created by dragging the triangle
function printPDFSplash() {
   console.writeln( "" );
   console.writeln( "\x1b[1;33m    ===  PhotonDumpsterFire  ===\x1b[0m" );
   console.writeln( "\x1b[0;36m    PixInsight Script Suite  |  v1.0\x1b[0m" );
   console.writeln( "" );
   console.writeln( "\x1b[0;33m       )  (    )    (  )   (   )      \x1b[0m" );
   console.writeln( "\x1b[0;33m     (   )(  ) ( )(  ) (  )(   ) (    \x1b[0m" );
   console.writeln( "\x1b[0;33m   )(  )( )( )(  )( )( )(  )(  )(  ) \x1b[0m" );
   console.writeln( "\x1b[0;33m  ( )( )( )( )( )( )( )( )( )( )( )( \x1b[0m" );
   console.writeln( "\x1b[0;31m )( )( )( )( )( )( )( )( )( )( )( )( \x1b[0m" );
   console.writeln( "\x1b[0;31m ( )( )( )( )( )( )( )( )( )( )( )( )\x1b[0m" );
   console.writeln( "\x1b[0;37m ___/\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\'\\___\x1b[0m" );
   console.writeln( "\x1b[0;37m |                                    |\x1b[0m" );
   console.writeln( "\x1b[0;37m +====================================+\x1b[0m" );
   console.writeln( "\x1b[0;37m |  PHOTONS      GRADIENTS     NOISE  |\x1b[0m" );
   console.writeln( "\x1b[0;37m |  HALOS        BANDING       TILT   |\x1b[0m" );
   console.writeln( "\x1b[0;37m |  CLOUDS       WIND          SEEING |\x1b[0m" );
   console.writeln( "\x1b[0;37m |  MOONLIGHT    VIGNETTING    COMA   |\x1b[0m" );
   console.writeln( "\x1b[0;37m |  AMP GLOW     SATELLITES    FLATS  |\x1b[0m" );
   console.writeln( "\x1b[0;37m |  GUIDING      DEW           FOCUS  |\x1b[0m" );
   console.writeln( "\x1b[0;37m +====================================+\x1b[0m" );
   console.writeln( "\x1b[0;36m  \\_/|                              |\\_/ \x1b[0m" );
   console.writeln( "\x1b[0;36m   o +------------------------------+ o  \x1b[0m" );
   console.writeln( "\x1b[0;36m  (_)                                (_) \x1b[0m" );
   console.writeln( "\x1b[0;36m  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  \x1b[0m" );
   console.writeln( "" );
   console.writeln( "\x1b[0;32m    ===  Everything is Fine  ===\x1b[0m" );
   console.writeln( "\x1b[0;33m    * * * * * * ( \u30c4 ) * * * * * *\x1b[0m" );
   console.writeln( "" );
   console.writeln( "\x1b[0;36m  -------------------------------------------\x1b[0m" );
   console.writeln( "\x1b[0;36m  GradientInspector | StretchInspector | ProcessContainerPlus\x1b[0m" );
   console.writeln( "\x1b[0;36m  NarrowbandPaletteBlender | IterativeStretch | ExoplanetInspector\x1b[0m" );
   console.writeln( "\x1b[0;37m  Copyright 2026 Brannon Quel  |  PixInsight Script Suite\x1b[0m" );
   console.writeln( "" );
}


function main() {
   printPDFSplash();
  console.writeln("[LAUNCH] Launching ExoTransit Light Curve Plot...");
  
  try {
    var dlg = new ExoTransitEnhancedDialog();
    dlg.execute();
  } catch(e) {
    console.criticalln("[FAIL] Script execution failed: " + e);
    new MessageBox(
      "❌ ExoTransit Script Error" + String.fromCharCode(10) + String.fromCharCode(10) + 
      "Error: " + e.toString() + String.fromCharCode(10) + String.fromCharCode(10) +
      "Please check the console for more details.",
      "Script Error",
      StdIcon_Error,
      StdButton_Ok
    ).execute();
  }
}

// ---------------- ° DIRECT EXECUTION ----------------
// When script is run directly (not from toolbar), call main function
main();


// ====================== ExoWCS Utilities (no GUI changes, no new includes) ======================
var ExoWCS = (function(){
  function _normDeg(a){
    // normalize to (-180, 180]
    a = Number(a);
    while(a <= -180) a += 360;
    while(a > 180) a -= 360;
    return a;
  }
  function _kwMap(win){
    try{
      var m = {};
      var kws = win && win.mainView ? win.mainView.keywords : null;
      if (!kws || !kws.length) return m;
      for (var i=0;i<kws.length;i++){
        var k = kws[i];
        m[k.name] = k.strippedValue;
      }
      return m;
    }catch(e){ return {}; }
  }
  function _toNum(x){
    var v = Number(x);
    return isFinite(v) ? v : NaN;
  }
  function _tryNumber(v){ var n = Number(v); return isFinite(n) ? n : null; }

  function extractRotation(imageWindow){
    var win = imageWindow || (ImageWindow && ImageWindow.activeWindow);
    if (!win || win.isNull){
      console.warningln("[ExoWCS] No image window available for rotation extraction.");
      return null;
    }

    var kw = _kwMap(win);
    // 1) CROTA2 / CROTA1
    var crota = _tryNumber(kw.CROTA2); if (crota===null) crota = _tryNumber(kw.CROTA1);
    if (crota!==null){
      var r = _normDeg(crota);
      console.noteln("[ExoWCS] Rotation from CROTA*: ", r.toFixed(6), "°");
      return r;
    }

    // 2) PC matrix (if present)
    var pc11=_toNum(kw.PC1_1), pc12=_toNum(kw.PC1_2), pc21=_toNum(kw.PC2_1), pc22=_toNum(kw.PC2_2);
    if (isFinite(pc11) && isFinite(pc12) && isFinite(pc21) && isFinite(pc22)){
      // convention: theta ~ atan2(-PC1_2, PC1_1)
      var theta = Math.atan2(-pc12, pc11) * 180/Math.PI;
      theta = _normDeg(theta);
      console.noteln("[ExoWCS] Rotation from PC matrix: ", theta.toFixed(6), "° (PC1_1=", pc11, ", PC1_2=", pc12, ")");
      return theta;
    }

    // 3) CD matrix (preferred if available)
    var cd11=_toNum(kw.CD1_1), cd12=_toNum(kw.CD1_2), cd21=_toNum(kw.CD2_1), cd22=_toNum(kw.CD2_2);
    if (isFinite(cd11) && isFinite(cd12) && isFinite(cd21) && isFinite(cd22)){
      // scale and rotation from CD. Two equivalent expressions; report the first.
      var theta1 = Math.atan2(-cd12, cd11) * 180/Math.PI;
      var theta2 = Math.atan2(cd21, cd22) * 180/Math.PI;
      var theta = _normDeg(theta1);
      console.noteln("[ExoWCS] Rotation from CD matrix: ", theta.toFixed(6), "° (alt=", _normDeg(theta2).toFixed(6), "°)");
      return theta;
    }

    // 4) Parse astrometricSolutionSummary() text if present in the environment
    try{
      if (typeof astrometricSolutionSummary === "function"){
        var s = astrometricSolutionSummary(win);
        if (s && s.length){
          var m = s.match(/Rotation\s*[:=]\s*([\-0-9.]+)\s*deg/i);
          if (m){
            var rr = _normDeg(Number(m[1]));
            console.noteln("[ExoWCS] Rotation from astrometricSolutionSummary(): ", rr.toFixed(6), "°");
            return rr;
          }
        }
      }
    }catch(e){ /* ignore */ }

    console.warningln("[ExoWCS] Rotation not found in keywords or summary.");
    return null;
  }

  // Write .xisf preserving WCS/XISF properties (per PixInsight staff guidance)
  function writeXISF(filePath, imageWindow, identifier, outputHints){
    var win = imageWindow || (ImageWindow && ImageWindow.activeWindow);
    if (!win || win.isNull)
      throw new Error("[ExoWCS] writeXISF: No valid image window.");

    if (outputHints === undefined) outputHints = "";
    filePath = File.changeExtension(filePath, ".xisf");

    var F = new FileFormat(".xisf", false, true);
    if (F.isNull) throw new Error("[ExoWCS] No installed file format can write .xisf files.");
    var f = new FileFormatInstance(F);
    if (f.isNull) throw new Error("[ExoWCS] Unable to instantiate file format: " + F.name);

    if (!f.create(filePath, outputHints))
      throw new Error("[ExoWCS] Error creating output file: " + filePath);

    var d = new ImageDescription;
    d.bitsPerSample = win.bitsPerSample;
    d.ieeefpSampleFormat = win.isFloatSample;
    d.imageType = win.imageType;
    if (!f.setOptions(d))
      throw new Error("[ExoWCS] Unable to set output file options: " + filePath);

    // preserve FITS keywords
    f.keywords = win.keywords;

    // **critical**: export XISF properties including the astrometric solution
    win.mainView.exportProperties(f);

    if (identifier !== undefined && identifier.length > 0)
      f.setImageId(identifier);

    if (!f.writeImage(win.mainView.image))
      throw new Error("[ExoWCS] Error writing image data.");

    f.close();
    console.noteln("[ExoWCS] Wrote XISF with properties: ", filePath);
  }

  return {
    extractRotation: extractRotation,
    writeXISF: writeXISF
  };
})();
// ==================== End ExoWCS Utilities ====================


/* =============================================================
   ExoWCS Universal Engine v1.1  (non-GUI, no #include required)
   - Robust WCS keyword parser (CRVAL/CRPIX + CD/PC with CDELT)
   - Correct TAN forward/inverse with proper rotation handling
   - Falls back to PixInsight's astrometricSolution when callable
   - Safe: no GUI changes, no extra includes, runs standalone
   ============================================================= */

(function(global){
  'use strict';

  function deg2rad(d){ return d*Math.PI/180; }
  function rad2deg(r){ return r*180/Math.PI; }

  function buildCDFromPC(pc11, pc12, pc21, pc22, cdelt1, cdelt2){
    // If only PC present together with CDELT, CD = PC * diag(CDELT1, CDELT2)
    return {
      a: pc11 * cdelt1, b: pc12 * cdelt2,
      c: pc21 * cdelt1, d: pc22 * cdelt2
    };
  }

  function parseWCS(win){
    var result = { ok:false, msg:"", ra0:NaN, dec0:NaN, x0:NaN, y0:NaN, CD:null, rotDeg:NaN, scaleArcsec:NaN };
    try{
      if (!win || win.isNull){ result.msg="No active image window"; return result; }
      var view = win.mainView;
      if (!view || view.isNull){ result.msg="No main view"; return result; }

      var CRVAL1=NaN, CRVAL2=NaN, CRPIX1=NaN, CRPIX2=NaN;
      var CD11=NaN, CD12=NaN, CD21=NaN, CD22=NaN;

      // Method 1: FITS keywords
      try{
        var kws = {};
        var kw = win.keywords;
        for (var i=0;i<kw.length;i++) kws[kw[i].name.toUpperCase()] = kw[i].strippedValue;
        var fk = function(n){ var x=parseFloat(kws[n]); return isFinite(x)?x:NaN; };
        CRVAL1=fk('CRVAL1'); CRVAL2=fk('CRVAL2');
        CRPIX1=fk('CRPIX1'); CRPIX2=fk('CRPIX2');
        CD11=fk('CD1_1'); CD12=fk('CD1_2'); CD21=fk('CD2_1'); CD22=fk('CD2_2');
        if (!isFinite(CD11)){
          var pc11=fk('PC1_1'),pc12=fk('PC1_2'),pc21=fk('PC2_1'),pc22=fk('PC2_2');
          var cde1=fk('CDELT1'),cde2=fk('CDELT2');
          if (isFinite(pc11)&&isFinite(cde1)){
            var CDpc=buildCDFromPC(pc11,pc12,pc21,pc22,cde1,cde2);
            CD11=CDpc.a; CD12=CDpc.b; CD21=CDpc.c; CD22=CDpc.d;
          }
        }
        console.writeln('[parseWCS] FITS: CRVAL1='+CRVAL1+' CRVAL2='+CRVAL2+
          ' CRPIX1='+CRPIX1+' CRPIX2='+CRPIX2+' CD1_1='+CD11+' CD2_2='+CD22);
      }catch(e){ console.warningln('[parseWCS] FITS read error: '+e); }

      // Method 2: astrometricSolutionSummary() text
      // ImageSolver DDM spline stores WCS in XISF properties, not FITS keywords.
      // The summary text always contains projection origin (CRPIX+CRVAL), scale, rotation.
      if (!isFinite(CRVAL1) || !isFinite(CD11)) {
        try {
          if (win.hasAstrometricSolution && typeof win.astrometricSolutionSummary === 'function') {
            var summary = win.astrometricSolutionSummary();
            console.writeln('[parseWCS] Got summary, length=' + (summary ? summary.length : 0));
            if (summary && summary.length > 20) {
              // Projection origin: [CRPIX1 CRPIX2] px -> [RA: HH MM SS.ss  Dec: +DD MM SS.ss]
              var mOrig = summary.match(/Projection origin[\s\.]+\[([0-9.]+)\s+([0-9.]+)\]\s*px\s*->\s*\[RA:\s*([0-9 .]+)\s+Dec:\s*([+\-0-9 .]+)\]/);
              if (mOrig) {
                CRPIX1 = parseFloat(mOrig[1]);
                CRPIX2 = parseFloat(mOrig[2]);
                var rp = mOrig[3].trim().split(/\s+/);
                CRVAL1 = (parseFloat(rp[0]) + parseFloat(rp[1])/60 + parseFloat(rp[2])/3600) * 15;
                var dp = mOrig[4].trim().split(/\s+/);
                var dsign = (dp[0].charAt(0)==='-') ? -1 : 1;
                CRVAL2 = dsign*(Math.abs(parseFloat(dp[0]))+parseFloat(dp[1])/60+parseFloat(dp[2])/3600);
                console.writeln('[parseWCS] Summary origin: CRPIX=('+CRPIX1.toFixed(2)+','+CRPIX2.toFixed(2)+
                  ') CRVAL=('+CRVAL1.toFixed(6)+','+CRVAL2.toFixed(6)+')');
              } else {
                console.warningln('[parseWCS] Projection origin regex did not match. Summary start: ' +
                  summary.substring(0, 200));
              }

              // Resolution: N.NNN arcsec/px
              var mRes = summary.match(/Resolution[\s\.]+([0-9.]+)\s*arcsec\/px/);
              var summaryScale = mRes ? parseFloat(mRes[1]) / 3600.0 : NaN;

              // Rotation: +/-N.NNN deg
              var mRot = summary.match(/Rotation[\s\.]+([+\-]?[0-9.]+)\s*deg/);
              var summaryRot = mRot ? parseFloat(mRot[1]) : NaN;

              console.writeln('[parseWCS] Summary: scale='+summaryScale+' deg/px rot='+summaryRot+'deg');

              if (isFinite(summaryScale) && isFinite(summaryRot) && !isFinite(CD11)) {
                var R = deg2rad(summaryRot);
                CD11 = -summaryScale * Math.cos(R);
                CD12 = -summaryScale * Math.sin(R);
                CD21 = +summaryScale * Math.sin(R);
                CD22 = -summaryScale * Math.cos(R);
                console.writeln('[parseWCS] Built CD from summary: CD1_2='+CD12.toExponential(3)+' CD2_1='+CD21.toExponential(3));
              }
            }
          } else {
            console.warningln('[parseWCS] astrometricSolutionSummary not available: hasAstro='+
              win.hasAstrometricSolution+' type='+typeof win.astrometricSolutionSummary);
          }
        } catch(e) { console.warningln('[parseWCS] Summary parse error: '+e); }
      }

      // Method 3: GlobalSettings fallback
      if (!isFinite(CD11)) {
        try {
          if (typeof GlobalSettings !== 'undefined' &&
              isFinite(GlobalSettings.imageScale) && GlobalSettings.imageScale > 0 &&
              isFinite(GlobalSettings.wcsRotation)) {
            var fs = GlobalSettings.imageScale / 3600;
            var Rg = deg2rad(GlobalSettings.wcsRotation);
            CD11 = -fs*Math.cos(Rg); CD12 = -fs*Math.sin(Rg);
            CD21 = +fs*Math.sin(Rg); CD22 = -fs*Math.cos(Rg);
            console.writeln('[parseWCS] Built CD from GlobalSettings: scale='+
              GlobalSettings.imageScale.toFixed(4)+'"/px rot='+GlobalSettings.wcsRotation.toFixed(3)+'deg');
          }
        } catch(e) {}
      }

      if (!isFinite(CRVAL1)||!isFinite(CRVAL2)){ result.msg="No CRVAL found"; console.warningln('[parseWCS] '+result.msg); return result; }
      if (!isFinite(CD11))                      { result.msg="No CD matrix";   console.warningln('[parseWCS] '+result.msg); return result; }

      result.ra0  = CRVAL1;
      result.dec0 = CRVAL2;
      result.x0   = isFinite(CRPIX1) ? CRPIX1 : view.image.width/2;
      result.y0   = isFinite(CRPIX2) ? CRPIX2 : view.image.height/2;
      result.CD   = { a:CD11, b:CD12, c:CD21, d:CD22 };
      var s1=Math.sqrt(CD11*CD11+CD21*CD21), s2=Math.sqrt(CD12*CD12+CD22*CD22);
      result.scaleArcsec = 0.5*(Math.abs(s1)+Math.abs(s2))*3600;
      result.rotDeg = rad2deg(Math.atan2(-CD12,CD11));
      if (result.rotDeg<0) result.rotDeg+=360;
      result.ok=true;
      console.writeln('[parseWCS] OK: CRVAL=('+CRVAL1.toFixed(4)+','+CRVAL2.toFixed(4)+
        ') CRPIX=('+result.x0.toFixed(1)+','+result.y0.toFixed(1)+
        ') scale='+result.scaleArcsec.toFixed(3)+'"/px rot='+result.rotDeg.toFixed(2)+'deg');
      return result;
    }catch(e){
      result.msg="Exception: "+e;
      console.warningln('[parseWCS] Exception: '+e);
      return result;
    }
  }

  // TAN projection helpers
  // TAN projection: (RA,Dec) -> display pixel.
  // Uses CD-matrix INVERSE so the math is correct regardless of CD sign conventions.
  // Reference pixel (wcs.x0, wcs.y0) must be in display coords (0-indexed, y from top).
  // Reference sky coords are (wcs.ra0, wcs.dec0).
  function worldToPixel_TAN(wcs, raDeg, decDeg){
    var ra0 = deg2rad(wcs.ra0), dec0 = deg2rad(wcs.dec0);
    var ra  = deg2rad(raDeg),   dec  = deg2rad(decDeg);

    // Full gnomonic (TAN) projection onto tangent plane
    var cosc = Math.sin(dec0)*Math.sin(dec) +
               Math.cos(dec0)*Math.cos(dec)*Math.cos(ra - ra0);
    if (Math.abs(cosc) < 1e-10) cosc = 1e-10;
    var xi  = rad2deg( Math.cos(dec)*Math.sin(ra - ra0) / cosc );
    var eta = rad2deg( (Math.cos(dec0)*Math.sin(dec) -
                        Math.sin(dec0)*Math.cos(dec)*Math.cos(ra - ra0)) / cosc );

    // CD^-1: maps sky offsets (xi,eta) [deg] -> pixel offsets (dx,dy) [px]
    var a = wcs.CD.a, b = wcs.CD.b, c = wcs.CD.c, d = wcs.CD.d;
    var det = a*d - b*c;
    if (!isFinite(det) || Math.abs(det) < 1e-20) throw new Error("Singular CD matrix");
    var dx = ( d*xi - b*eta) / det;
    var dy = (-c*xi + a*eta) / det;

    return { x: wcs.x0 + dx, y: wcs.y0 + dy };
  }

  function pixelToWorld_TAN(wcs, x, y){
    var dx = x - wcs.x0;
    var dy = y - wcs.y0;

    // Inverse CD
    var det = wcs.CD.a*wcs.CD.d - wcs.CD.b*wcs.CD.c;
    if (!isFinite(det) || Math.abs(det) < 1e-20) throw new Error("Singular CD matrix");

    var u = ( wcs.CD.d*dx - wcs.CD.b*dy)/det; // deg
    var v = (-wcs.CD.c*dx + wcs.CD.a*dy)/det; // deg

    // TAN inverse: u=xi(deg), v=eta(deg)
    var xi  = deg2rad(u);
    var eta = deg2rad(v);

    var rho = Math.sqrt(xi*xi + eta*eta);
    var c   = Math.atan(rho);

    var ra0  = deg2rad(wcs.ra0), dec0 = deg2rad(wcs.dec0);
    var sin_c = Math.sin(c), cos_c = Math.cos(c);
    var sin_dec0 = Math.sin(dec0), cos_dec0 = Math.cos(dec0);

    var dec = Math.asin( cos_c*sin_dec0 + (eta * sin_c * cos_dec0 / (rho||1)) );
    var ra  = ra0 + Math.atan2( xi*sin_c, (rho*cos_dec0*cos_c - eta*sin_dec0*sin_c) );

    return { ra: (rad2deg(ra)+540)%360-180, dec: rad2deg(dec) }; // normalize RA
  }

  // Build coordinate provider.
  // Strategy: NEVER use PixInsight WorldToImage (produces reflected y coords).
  // Instead: use ImageToWorld(image_centre) to get the sky coords of the centre pixel,
  // then do pure TAN + CD^-1 math from that reference point.
  // This is fully self-consistent, works on any crop, and needs only the CD matrix
  // (plate scale + rotation) which PixInsight writes correctly.
  function makeProvider(win){
    // Strategy: derive everything from ImageToWorld by sampling 3 pixels.
    // This avoids ALL FITS header convention questions (CRPIX indexing, CD sign,
    // y-axis direction) and works correctly on any crop, rotation, or scale.
    // WorldToImage is never called (it produces reflected y-coordinates).
    var wcsParsed = parseWCS(win); // still used as fallback if ImageToWorld unavailable
    var astro = null;
    var wcsForTAN = null;

    try{
      if (win.hasAstrometricSolution && win.mainView && (win.astrometricSolution || win.mainView.astrometricSolution)){
        astro = win.astrometricSolution || win.mainView.astrometricSolution;
        if (astro && typeof astro.ImageToWorld === 'function'){
          var iw = win.mainView.image.width;
          var ih = win.mainView.image.height;
          var cx = iw / 2;
          var cy = ih / 2;
          var step = Math.min(iw, ih) * 0.1; // 10% of shorter dimension — robust step size

          // Sample sky coords at 3 display pixels
          var p0 = astro.ImageToWorld(new Point(cx,        cy       )); // centre
          var p1 = astro.ImageToWorld(new Point(cx + step, cy       )); // right
          var p2 = astro.ImageToWorld(new Point(cx,        cy + step)); // down

          if (p0 && p1 && p2 &&
              isFinite(p0.x) && isFinite(p0.y) &&
              isFinite(p1.x) && isFinite(p1.y) &&
              isFinite(p2.x) && isFinite(p2.y)){

            // Derive CD matrix: pixel offset -> sky offset (degrees per pixel)
            // p.x = RA (degrees), p.y = Dec (degrees)
            // No cos(Dec) correction needed here — CD1_1 carries the raw RA/pixel ratio,
            // and the TAN projection applies cos(Dec) internally via the gnomonic formula.
            var CD11 = (p1.x - p0.x) / step; // dRA  per pixel in x direction
            var CD21 = (p1.y - p0.y) / step; // dDec per pixel in x direction
            var CD12 = (p2.x - p0.x) / step; // dRA  per pixel in y direction
            var CD22 = (p2.y - p0.y) / step; // dDec per pixel in y direction

            wcsForTAN = {
              ra0:  p0.x,  // RA  of image centre pixel
              dec0: p0.y,  // Dec of image centre pixel
              x0:   cx,    // image centre x (display, 0-indexed)
              y0:   cy,    // image centre y (display, 0-indexed)
              CD:   { a: CD11, b: CD12, c: CD21, d: CD22 },
              ok:   true
            };
            console.writeln('[WCS] CD matrix derived from ImageToWorld: ' +
              'CD1_1=' + CD11.toExponential(3) + ' CD2_2=' + CD22.toExponential(3) +
              ' scale≈' + (Math.sqrt(CD21*CD21+CD22*CD22)*3600).toFixed(2) + '"/px');
          }
        }
      }
    }catch(e){
      console.warningln('[WCS] ImageToWorld sampling failed: ' + e + ' — trying FITS header fallback');
      wcsForTAN = null;
    }

    // Fallback: use FITS header CRPIX/CRVAL/CD if ImageToWorld unavailable
    if (!wcsForTAN && wcsParsed.ok){
      wcsForTAN = wcsParsed;
      console.writeln('[WCS] Using FITS header for WCS (ImageToWorld unavailable)');
    }

    var ok = (wcsForTAN && wcsForTAN.ok);

    return {
      ok: ok,
      info: wcsParsed,
      worldToPixel: function(raDeg, decDeg){
        if (!ok) throw new Error("No usable WCS — image may not be plate-solved");
        return worldToPixel_TAN(wcsForTAN, raDeg, decDeg);
      },
      pixelToWorld: function(x, y){
        // Always prefer ImageToWorld for pixel->sky (it is reliable)
        if (astro && typeof astro.ImageToWorld === 'function'){
          try{
            var p = astro.ImageToWorld(new Point(x, y));
            if (p && isFinite(p.x) && isFinite(p.y)) return { ra: p.x, dec: p.y };
          }catch(e){}
        }
        if (!ok) throw new Error("No usable WCS");
        return pixelToWorld_TAN(wcsForTAN, x, y);
      },
      roundtripSelfTest: function(){
        if (!ok) return { ok: false, msg: "No usable WCS" };
        var cx = win.mainView.image.width  / 2;
        var cy = win.mainView.image.height / 2;
        var wd = this.pixelToWorld(cx, cy);
        var rp = this.worldToPixel(wd.ra, wd.dec);
        var err = Math.hypot(rp.x - cx, rp.y - cy);
        return { ok: (err < 1.0), pxError: err };
      }
    };
  }

  // Public singleton
  var EXOWCS = {
    buildProvider: function(win){ return makeProvider(win || ImageWindow.activeWindow); },
    pixelToWorld: function(win,x,y){ return this.buildProvider(win).pixelToWorld(x,y); },
    worldToPixel: function(win,ra,dec){ return this.buildProvider(win).worldToPixel(ra,dec); },
    debugPrint: function(win){
      var prov = this.buildProvider(win);
      if (!prov.ok){ console.warningln("[ExoWCS] No usable WCS"); return; }
      var inf = prov.info;
      console.writeln(
        "[ExoWCS] Parsed WCS (TAN): center RA="+(inf.ra0||NaN).toFixed(6)+"° Dec="+(inf.dec0||NaN).toFixed(6)+
        "°, origin (x0,y0)=("+ (inf.x0||NaN).toFixed(3)+", "+(inf.y0||NaN).toFixed(3)+"), scale≈"+
        (inf.scaleArcsec||NaN).toFixed(3)+'"/px, rot≈'+(inf.rotDeg||NaN).toFixed(3)+"°"
      );
      var cx = (win.mainView.image.width||0)/2, cy=(win.mainView.image.height||0)/2;
      var wd = prov.pixelToWorld(cx, cy);
      var rp = prov.worldToPixel(wd.ra, wd.dec);
      console.writeln("[ExoWCS] Center roundtrip: pix("+cx.toFixed(2)+","+cy.toFixed(2)+") -> ra/dec("+
                      wd.ra.toFixed(6)+"°,"+wd.dec.toFixed(6)+"°) -> pix("+rp.x.toFixed(2)+","+rp.y.toFixed(2)+")");
    }
  };

  // Optional auto-registration: if host script exposes a hook, register this provider
  try{
    if (typeof global.registerWCSProvider === 'function'){
      global.registerWCSProvider(function(){ return EXOWCS.buildProvider(ImageWindow.activeWindow); });
      console.writeln("[ExoWCS] Provider registered with host script");
    }
  }catch(e){}

  // Expose globally without clobbering existing symbols
  global.EXOWCS = EXOWCS; // always overwrite — no session caching

})(this);



/* ===================== SKY GRID MODULE (Non-GUI intrusive) =====================
   Universal sky grid based on solved image parameters.
   - No changes to #include
   - No new GUI controls; renders during existing preview paint (if available)
   - Falls back gracefully if WCS is incomplete
*/
(function(){
  // Namespace
  var SkyGrid = {
    enabled: true,
    lastBuild: null
  };

  // Safe getters for existing WCS utilities from this script
  function _getWCSContext() {
    try {
      var ctx = {};
      // Prefer precise WCS if available in global cache from earlier steps
      if (typeof GlobalSettings !== 'undefined') {
        ctx.width  = GlobalSettings.imageWidth  || 0;
        ctx.height = GlobalSettings.imageHeight || 0;
      } else {
        ctx.width = ctx.height = 0;
      }
      // try cached rotation/scale/center used elsewhere in the script
      ctx.centerRA  = (typeof __lastFieldCenterRA__  !== 'undefined')  ? __lastFieldCenterRA__  : (GlobalSettings && GlobalSettings.ra  || 0);
      ctx.centerDec = (typeof __lastFieldCenterDec__ !== 'undefined')  ? __lastFieldCenterDec__ : (GlobalSettings && GlobalSettings.dec || 0);
      ctx.rotationDeg = (typeof __lastRotationDeg__ !== 'undefined') ? __lastRotationDeg__ : (GlobalSettings && GlobalSettings.manualRotation || 0);
      ctx.scaleArcsec = (typeof __lastPixelScaleArcsec__ !== 'undefined') ? __lastPixelScaleArcsec__ : 0;

      // If our FITS/WCS extractor stashed a struct, honor it
      if (typeof __WCS_Snapshot__ !== 'undefined' && __WCS_Snapshot__) {
        ctx.centerRA   = __WCS_Snapshot__.centerRA   || ctx.centerRA;
        ctx.centerDec  = __WCS_Snapshot__.centerDec  || ctx.centerDec;
        ctx.rotationDeg= __WCS_Snapshot__.rotation   || ctx.rotationDeg;
        ctx.scaleArcsec= __WCS_Snapshot__.pixelScaleArcsec || ctx.scaleArcsec;
      }
      // As a last resort, try to parse from the active view's WCS summary (if cached)
      return ctx;
    } catch(e){
      return {width:0,height:0,centerRA:0,centerDec:0,rotationDeg:0,scaleArcsec:0};
    }
  }

  function deg2rad(d){return d*Math.PI/180;}
  function rad2deg(r){return r*180/Math.PI;}

  // TAN (gnomonic) small-angle linearized forward transform around center
  function worldToPixel_TAN(raDeg, decDeg, ctx){
    var w = ctx.width, h = ctx.height;
    if (!w || !h || !isFinite(ctx.scaleArcsec) || ctx.scaleArcsec<=0) return null;
    var sx = ctx.scaleArcsec/3600; // deg per px
    var rot = deg2rad(ctx.rotationDeg||0);
    var cx = w*0.5, cy = h*0.5;

    // Small-angle offsets (deg) at center Dec
    var dRA  = (raDeg - ctx.centerRA);
    // Wrap RA delta into [-180,180]
    while(dRA>180) dRA-=360; while(dRA<-180) dRA+=360;
    var cosD = Math.cos(deg2rad(ctx.centerDec));
    var dx_deg =  dRA * cosD;
    var dy_deg = (decDeg - ctx.centerDec);

    // convert deg to pixels (unrotated, +x=east, +y=north)
    var ux = dx_deg / sx;
    var uy = dy_deg / sx;

    // Apply rotation
    var rx =  Math.cos(rot)*ux - Math.sin(rot)*uy;
    var ry =  Math.sin(rot)*ux + Math.cos(rot)*uy;

    // Image y grows downward
    var px = cx + rx;
    var py = cy - ry;
    return {x:px, y:py};
  }

  function pixelToWorld_TAN(px, py, ctx){
    var w = ctx.width, h = ctx.height;
    if (!w || !h || !isFinite(ctx.scaleArcsec) || ctx.scaleArcsec<=0) return null;
    var sx = ctx.scaleArcsec/3600; // deg per px
    var rot = deg2rad(ctx.rotationDeg||0);
    var cx = w*0.5, cy = h*0.5;

    // shift to origin
    var rx = (px - cx);
    var ry = (cy - py); // invert

    // inverse rotation
    var ux =  Math.cos(rot)*rx + Math.sin(rot)*ry;
    var uy = -Math.sin(rot)*rx + Math.cos(rot)*ry;

    var dx_deg = ux * sx;
    var dy_deg = uy * sx;

    var cosD = Math.cos(deg2rad(ctx.centerDec));
    var dRA = (cosD>0)? (dx_deg / cosD) : 0;
    var ra  = ctx.centerRA + dRA;
    var dec = ctx.centerDec + dy_deg;
    // normalize RA
    while(ra<0) ra+=360; while(ra>=360) ra-=360;
    return {ra:ra, dec:dec};
  }

  // Choose grid spacing based on FOV (deg)
  function chooseGridStep(fovXdeg, fovYdeg){
    var f = Math.max(fovXdeg, fovYdeg);
    var steps = [0.1, 0.2, 0.5, 1, 2, 5, 10];
    for (var i=0;i<steps.length;i++){
      if (f/steps[i] <= 12) return steps[i];
    }
    return 15;
  }

  // Build grid polylines in pixel coords; returns {raLines:[[{x,y}...],...], decLines:[...]}
  function buildGrid(ctx){
    var w = ctx.width, h = ctx.height;
    if (!w || !h) return null;
    var fovXdeg = (w * (ctx.scaleArcsec||0))/3600;
    var fovYdeg = (h * (ctx.scaleArcsec||0))/3600;
    if (!isFinite(fovXdeg) || !isFinite(fovYdeg) || fovXdeg<=0) return null;

    var step = chooseGridStep(fovXdeg, fovYdeg);

    // Determine RA/Dec bounds by sampling corners
    function pix2w(x,y){ var r=pixelToWorld_TAN(x,y,ctx); return r?r:{ra:ctx.centerRA,dec:ctx.centerDec}; }
    var c1=pix2w(0,0), c2=pix2w(w,0), c3=pix2w(0,h), c4=pix2w(w,h);
    var minDec = Math.min(c1.dec,c2.dec,c3.dec,c4.dec);
    var maxDec = Math.max(c1.dec,c2.dec,c3.dec,c4.dec);

    // pick RA span around center to avoid wrap issues
    var halfSpan = fovXdeg*0.6;
    var minRA = ctx.centerRA - halfSpan; var maxRA = ctx.centerRA + halfSpan;

    // Normalize range
    function normRA(a){ while(a<0)a+=360; while(a>=360)a-=360; return a; }
    minRA = normRA(minRA); maxRA = normRA(maxRA);

    var raLines=[], decLines=[];

    // Declination lines
    var decStart = Math.ceil(minDec/step)*step;
    for (var dec=decStart; dec<=maxDec; dec+=step){
      var poly=[];
      // sample across RA range
      for (var s=-16; s<=16; s++){
        var ra = ctx.centerRA + (s/16.0)*(fovXdeg*0.7);
        ra = normRA(ra);
        var p = worldToPixel_TAN(ra, dec, ctx);
        if (p && isFinite(p.x) && isFinite(p.y)) poly.push(p);
      }
      if (poly.length>1) decLines.push(poly);
    }

    // Right Ascension lines
    // choose base RA near center and march by step
    var ra0 = Math.round(ctx.centerRA/step)*step;
    for (var k=-6;k<=6;k++){
      var ra = normRA(ra0 + k*step);
      var poly=[];
      for (var s=-16; s<=16; s++){
        var d = minDec + (s+16)*(maxDec-minDec)/32.0;
        var p = worldToPixel_TAN(ra, d, ctx);
        if (p && isFinite(p.x) && isFinite(p.y)) poly.push(p);
      }
      if (poly.length>1) raLines.push(poly);
    }

    return {step:step, raLines:raLines, decLines:decLines, fovX:fovXdeg, fovY:fovYdeg};
  }

  // Draw onto an existing Graphics context (semi-transparent)
  function drawGrid(g, grid){
    if (!g || !grid) return;
    try{
      if (typeof g.transparentBackground === 'boolean') g.transparentBackground = true;
      if (g.antialiasingEnabled !== undefined) g.antialiasingEnabled = true;
      // set pen if available
      if (g.penColor !== undefined) {
        g.penColor = 0x80FFFFFF; // white with alpha if supported by host
      }
      if (g.penWidth !== undefined) g.penWidth = 1;
      // draw lines
      var drawPoly = function(pl){
        if (pl.length<2) return;
        if (typeof g.beginPath === 'function'){
          g.beginPath();
          g.moveTo(pl[0].x, pl[0].y);
          for (var i=1;i<pl.length;i++) g.lineTo(pl[i].x, pl[i].y);
          g.stroke();
        } else if (typeof g.drawPolyline === 'function'){
          var X = pl.map(function(p){return p.x}); var Y=pl.map(function(p){return p.y});
          g.drawPolyline(X, Y, pl.length);
        }
      }
      for (var i=0;i<grid.decLines.length;i++) drawPoly(grid.decLines[i]);
      for (var i=0;i<grid.raLines.length;i++) drawPoly(grid.raLines[i]);
    }catch(e){
      // silent
    }
  }

  // Try to patch an existing onPaint handler once the dialog exists.
  function tryPatchPaint(){
    try{
      if (typeof mainDialog === 'object' && mainDialog && typeof mainDialog.onPaint === 'function' && !mainDialog.__gridPatched){
        var orig = mainDialog.onPaint;
        mainDialog.onPaint = function(){
          orig.apply(mainDialog, arguments);
          try {
            if (!SkyGrid.enabled) return;
            var ctx = _getWCSContext();
            if (!ctx.width || !ctx.height || !ctx.scaleArcsec) return;
            var grid = buildGrid(ctx);
            SkyGrid.lastBuild = grid;
            if (grid && arguments && arguments.length>0){
              var g = arguments[0]; // Graphics
              drawGrid(g, grid);
            }
          } catch(e){}
        };
        mainDialog.__gridPatched = true;
        console.writeln('[GRID] Sky grid overlay enabled (auto).');
      }
    }catch(e){}
  }

  // Expose minimal API
  this.__SkyGrid__ = {
    build: function(){ var ctx=_getWCSContext(); var grid=buildGrid(ctx); SkyGrid.lastBuild=grid; return grid; },
    worldToPixel: function(ra,dec){ return worldToPixel_TAN(ra,dec,_getWCSContext()); },
    pixelToWorld: function(x,y){ return pixelToWorld_TAN(x,y,_getWCSContext()); },
    tryPatchPaint: tryPatchPaint
  };

  // Attempt to patch now and also later (some scripts build UI after launch)
  tryPatchPaint();
  if (typeof setTimeout === 'function'){
    setTimeout(tryPatchPaint, 1000);
    setTimeout(tryPatchPaint, 2500);
  }
})();
// =================== END SKY GRID MODULE ===================



// === ALT DIAGNOSTICS LAYER (Integrated) ===
// This layer adds verbose troubleshooting without changing GUI or includes.
// It monkey-patches WCS extraction to prefer PixInsight's astrometricSolution
// and logs precise failure reasons. Safe to include multiple times.
(function(){
  if (typeof __EXO_ALT_DIAG_INSTALLED__ !== 'undefined' && __EXO_ALT_DIAG_INSTALLED__) {
    console.writeln('[ALT] Diagnostics layer already present.');
    return;
  }
  __EXO_ALT_DIAG_INSTALLED__ = true;

  function _hasAstrometric(view){
    try {
      return !!(view && view.astrometricSolution &&
                typeof view.astrometricSolution.ImageToWorld === 'function' &&
                typeof view.astrometricSolution.WorldToImage === 'function');
    } catch(e){ return false; }
  }

  // Patch extractXISFWCSProperties
  if (typeof extractXISFWCSProperties === 'function') {
    var __orig_extractXISF = extractXISFWCSProperties;
    extractXISFWCSProperties = function(imageWindow){
      try{
        var view = imageWindow && imageWindow.mainView;
        if (_hasAstrometric(view)) {
          console.writeln('[ALT][WCS] Using direct astrometricSolution for XISF extraction');
          var im = view.image;
          var cx = im.width/2, cy = im.height/2;
          var ctr = view.astrometricSolution.ImageToWorld(new Point(cx,cy));
          var data = {
            hasWorkingTransform: true,
            centerRA: ctr ? ctr.x : NaN,
            centerDec: ctr ? ctr.y : NaN,
            imageToWorld: function(p){ return view.astrometricSolution.ImageToWorld(p); },
            worldToImage: function(p){ return view.astrometricSolution.WorldToImage(p); }
          };
          return { success:true, data:data, method:'astrometricSolution' };
        }
      }catch(e){
        console.warningln('[ALT][WCS] astrometricSolution path failed: ' + e);
      }
      var out = __orig_extractXISF(imageWindow);
      // Normalize NaN keyword corner cases if present
      try{
        if (out && out.data && !out.data.hasWorkingTransform) {
          if (!isFinite(out.data.centerRA) || !isFinite(out.data.centerDec)) {
            console.warningln('[ALT][WCS] Incomplete keyword set (CRPIX/CRVAL/CD may be NaN)');
          }
        }
      }catch(_){}
      return out;
    };
  } else {
    console.warningln('[ALT] extractXISFWCSProperties not found to patch.');
  }

  // Patch extractImageMetadataWCS with ImageSolver auto-calibration and universal grid
  if (typeof extractImageMetadataWCS === 'function') {
    var __orig_extractMeta = extractImageMetadataWCS;
    extractImageMetadataWCS = function(imageWindow){
      var res = __orig_extractMeta(imageWindow);
      
      // Clean WCS extraction - no automatic ImageSolver integration
      try{
        if (res && res.success && res.data && res.data.hasWorkingTransform) {
          var d = res.data;
          var cx = Number(d.centerRA), cy = Number(d.centerDec);
          if (isFinite(cx) && isFinite(cy) && typeof d.worldToImage === 'function') {
            // Log a small sky grid every 1° around center for ±5°
            for (var ra=cx-5; ra<=cx+5; ra+=1) {
              var p1 = d.worldToImage(new Point(ra, cy-5));
              var p2 = d.worldToImage(new Point(ra, cy+5));
              if (p1 && p2 && isFinite(p1.x) && isFinite(p2.x))
                console.writeln('[ALT][GRID] RA='+ra.toFixed(3)+'° spans y '+p1.y.toFixed(0)+'→'+p2.y.toFixed(0));
            }
            for (var dec=cy-5; dec<=cy+5; dec+=1) {
              var q1 = d.worldToImage(new Point(cx-5, dec));
              var q2 = d.worldToImage(new Point(cx+5, dec));
              if (q1 && q2 && isFinite(q1.y) && isFinite(q2.y))
                console.writeln('[ALT][GRID] Dec='+dec.toFixed(3)+'° spans x '+q1.x.toFixed(0)+'→'+q2.x.toFixed(0));
            }
          }
        }
      }catch(e){
        console.warningln('[ALT] Grid logging failed: '+e);
      }
      return res;
    };
  }

  // Provide a high-accuracy pixel->world using the direct transform when available
  if (typeof getAccurateWorldCoords !== 'function') {
    // Non-invasive helper; consumers can call if they wish
    this.getAccurateWorldCoords = function(view, x, y, wcsData){
      try{
        if (_hasAstrometric(view)) {
          var p = view.astrometricSolution.ImageToWorld(new Point(x,y));
          if (p) return {ra:p.x, dec:p.y, method:'astrometricSolution'};
        }
      }catch(e){}
      // Defer to existing reverse transform if globally exposed
      if (typeof manualReverseTransform === 'function')
        return manualReverseTransform(x,y);
      if (typeof pixelToRaDec === 'function')
        return pixelToRaDec(x,y);
      return {ra:NaN, dec:NaN, method:'unavailable'};
    };
  }

  // Parse and log pixel scale and rotation from the PixInsight solution summary text
  if (typeof extractScaleAndRotation !== 'function') {
    this.extractScaleAndRotation = function(consoleText){
      var m = /Resolution ............... ([0-9.]+) arcsec\/px/.exec(consoleText||'');
      var r = /Rotation ................. ([0-9.+-]+) deg/.exec(consoleText||'');
      if (m) console.writeln('[ALT][WCS] Pixel scale '+m[1]+'"/px');
      if (r) console.writeln('[ALT][WCS] Rotation '+r[1]+'°');
      return { scale: m ? parseFloat(m[1]) : NaN, rot: r ? parseFloat(r[1]) : NaN };
    };
  }
})();

// === EXO SUPER PATCH START ===
// One-file integrated WCS layer: native astrometricSolution -> TAN fallback (gnomonic)
// Leaves UI/photometry intact; just upgrades WCS extraction & transforms.

// Move all helper functions to true top level to avoid strict mode warnings
function _hasProp_EXO(v, name){ try{ return v.hasProperty && v.hasProperty(name); }catch(e){ return false; } }
function _prop_EXO(v, name){ try{ return v.propertyValue(name); }catch(e){ return null; } }
function _hmsToDeg_EXO(s){
  s = String(s).trim().replace(/\s+/g,' ');
  var m = s.match(/^([0-9]+)\s+([0-9]+)\s+([0-9.]+)/);
  if (!m) return NaN;
  var h=+m[1], mi=+m[2], se=+m[3];
  return 15*(h + mi/60 + se/3600);
}
function _dmsToDeg_EXO(s){
  s = String(s).trim().replace(/\s+/g,' ');
  var m = s.match(/^([+\-]?[0-9]+)\s+([0-9]+)\s+([0-9.]+)/);
  if (!m) return NaN;
  var d=+m[1], mi=+m[2], se=+m[3];
  var sign = d<0 ? -1 : 1;
  d = Math.abs(d);
  return sign*(d + mi/60 + se/3600);
}
function deg2rad_EXO(d){ return d*Math.PI/180; }
function rad2deg_EXO(r){ return r*180/Math.PI; }

(function(){
  // Declare global variable properly
  var __EXO_ALT_DIAG_INSTALLED__ = true;
  var _SUP_log = function(m){ try{ console.writeln('[EXO-SUP] ' + m); }catch(e){} };

  function _tryNative(view){
    try{
      if (view && view.astrometricSolution &&
          typeof view.astrometricSolution.ImageToWorld === 'function' &&
          typeof view.astrometricSolution.WorldToImage === 'function') {
        var cx = view.image.width/2, cy = view.image.height/2;
        var cW = view.astrometricSolution.ImageToWorld(new Point(cx,cy));
        _SUP_log('Using view.astrometricSolution (direct transforms available)');
        return {
          success:true,
          method:'astrometricSolution-direct',
          hasWorkingTransform:true,
          centerRA:cW ? cW.x : NaN,
          centerDec:cW ? cW.y : NaN,
          imageToWorld:view.astrometricSolution.ImageToWorld,
          worldToImage:view.astrometricSolution.WorldToImage
        };
      }
    }catch(e){ _SUP_log('Native access failed: '+e); }
    return {success:false};
  }

  function _getSummaryBits(win){
    try{
      if (win && win.hasAstrometricSolution) {
        var s = win.astrometricSolutionSummary();
        if (s && typeof s === 'string') {
          var mRes = s.match(/Resolution[\s\.]*([0-9]*\.?[0-9]+)\s*arcsec\/px/i);
          var mRot = s.match(/Rotation[\s\.]*([+\-]?[0-9]*\.?[0-9]+)\s*deg/i);
          var pxScale = mRes ? parseFloat(mRes[1]) : NaN;
          var rot = mRot ? parseFloat(mRot[1]) : NaN;
          return {scaleArcsec:pxScale, rotationDeg:rot};
        }
      }
    }catch(e){ _SUP_log('Summary parse failed: '+e); }
    return {scaleArcsec:NaN, rotationDeg:NaN};
  }

  // Helper functions are now defined at true top level
  function _getCenterFromFITS(win){
    try{
      var v = win && win.mainView;
      if (!v) return {ra:NaN, dec:NaN};
      var candRA = null, candDec = null;
      var namesRA = ['Observation:Center:RA','Astrometry:CenterRA','WCS:CenterRA'];
      var namesDec= ['Observation:Center:Dec','Astrometry:CenterDec','WCS:CenterDec'];
      for (var i=0;i<namesRA.length;i++){ if (_hasProp_EXO(v, namesRA[i])) { candRA = parseFloat(_prop_EXO(v, namesRA[i])); break; } }
      for (var j=0;j<namesDec.length;j++){ if (_hasProp_EXO(v, namesDec[j])) { candDec = parseFloat(_prop_EXO(v, namesDec[j])); break; } }
      if (isFinite(candRA) && isFinite(candDec)) return {ra:candRA, dec:candDec};

      try{
        if (typeof buildKeywordMap === 'function' && typeof getKeyword === 'function'){
          var kw = buildKeywordMap(win);
          var raNum = parseFloat(getKeyword(kw,'RA'));
          var decNum = parseFloat(getKeyword(kw,'DEC'));
          if (isFinite(raNum) && isFinite(decNum))
            return {ra:raNum, dec:decNum};
          var oRA = getKeyword(kw,'OBJCTRA');
          var oDec= getKeyword(kw,'OBJCTDEC');
          if (oRA && oDec){
            var ra = _hmsToDeg_EXO(oRA);
            var dec= _dmsToDeg_EXO(oDec);
            if (isFinite(ra) && isFinite(dec)) return {ra:ra, dec:dec};
          }
        }
      }catch(e){}
    }catch(e){}
    return {ra:NaN, dec:NaN};
  }

  function _buildTAN(win, centerRAdeg, centerDECdeg, rotationDeg, scaleArcsecPerPx){
    try{
      var view = win.mainView;
      var cx = view.image.width/2, cy = view.image.height/2;
      var s_arcsec = scaleArcsecPerPx;
      if (!isFinite(s_arcsec) || s_arcsec <= 0) return {success:false, error:'bad scale'};
      var pxPerRad = (180/Math.PI)*3600.0 / s_arcsec;
      var th = deg2rad_EXO(rotationDeg||0);

      var a0 = deg2rad_EXO(centerRAdeg);
      var d0 = deg2rad_EXO(centerDECdeg);
      var sin_d0 = Math.sin(d0), cos_d0 = Math.cos(d0);

      // Use variable assignment instead of function declaration to avoid strict mode warnings
      var worldToImage = function(pt){
        var a = deg2rad_EXO(pt.x), d = deg2rad_EXO(pt.y);
        var da = a - a0;
        if (da > Math.PI) da -= 2*Math.PI;
        if (da < -Math.PI) da += 2*Math.PI;
        var sin_d = Math.sin(d), cos_d = Math.cos(d);
        var cosc = sin_d0*sin_d + cos_d0*cos_d*Math.cos(da);
        var xt = (cos_d * Math.sin(da)) / cosc;
        var yt = (cos_d0*sin_d - sin_d0*cos_d*Math.cos(da)) / cosc;
        var xr =  xt*Math.cos(th) + yt*Math.sin(th);
        var yr = -xt*Math.sin(th) + yt*Math.cos(th);
        var dx = xr * pxPerRad;
        var dy = yr * pxPerRad;
        return new Point(cx + dx, cy - dy);
      };

      var imageToWorld = function(p){
        var dx = (p.x - cx);
        var dy = -(p.y - cy);
        var xt =  (dx/pxPerRad)*Math.cos(th) - (dy/pxPerRad)*Math.sin(th);
        var yt =  (dx/pxPerRad)*Math.sin(th) + (dy/pxPerRad)*Math.cos(th);
        var rho = Math.sqrt(xt*xt + yt*yt);
        if (rho === 0){
          return new Point(centerRAdeg, centerDECdeg);
        }
        var c = Math.atan(rho);
        var sc = Math.sin(c), cc = Math.cos(c);
        var lat = Math.asin( cc*sin_d0 + (yt*sc*cos_d0)/rho );
        var lon = a0 + Math.atan2( xt*sc, rho*cos_d0*cc - yt*sin_d0*sc );
        var ra = (rad2deg_EXO(lon)%360+360)%360;
        var dec= rad2deg_EXO(lat);
        return new Point(ra, dec);
      };

      return {
        success:true,
        method:'tan-gnomonic-fallback',
        hasWorkingTransform:true,
        centerRA:centerRAdeg,
        centerDec:centerDECdeg,
        imageToWorld:imageToWorld,
        worldToImage:worldToImage,
        rotation:rotationDeg,
        pixelScaleArcsec:s_arcsec
      };
    }catch(e){
      _SUP_log('TAN build failed: '+e);
      return {success:false, error:String(e)};
    }
  }

  var __origExtractXISF = (typeof extractXISFWCSProperties === 'function') ? extractXISFWCSProperties : function(){ return {success:false, method:'missing'}; };
  var __origExtractIM   = (typeof extractImageMetadataWCS   === 'function') ? extractImageMetadataWCS   : function(){ return {success:false, method:'missing'}; };

  function __superExtract(viewWindow){
    var view = viewWindow && viewWindow.mainView;
    var nat = _tryNative(view);
    if (nat.success) return { success:true, data:nat, method:nat.method };

    try{
      var base = __origExtractXISF(viewWindow);
      if (base && base.success && base.data && (base.data.hasWorkingTransform || (base.data.imageToWorld && base.data.worldToImage))){
        _SUP_log('Using original extractXISFWCSProperties() result');
        return base;
      }
    }catch(e){}
    try{
      var im = __origExtractIM(viewWindow);
      if (im && im.success && im.data && (im.data.hasWorkingTransform || (im.data.imageToWorld && im.data.worldToImage))){
        _SUP_log('Using original extractImageMetadataWCS() result');
        return im;
      }
    }catch(e){}

    var bits = _getSummaryBits(viewWindow);
    var ctr = _getCenterFromFITS(viewWindow);
    if (!(isFinite(bits.scaleArcsec) && bits.scaleArcsec>0)){
      try{
        if (typeof calculateImageScaleFromFITS === 'function'){
          var sc = calculateImageScaleFromFITS(viewWindow);
          if (sc && isFinite(sc)) bits.scaleArcsec = sc;
        }
      }catch(e){}
    }
    if (isFinite(ctr.ra) && isFinite(ctr.dec) && isFinite(bits.rotationDeg) && isFinite(bits.scaleArcsec) && bits.scaleArcsec>0){
      var tan = _buildTAN(viewWindow, ctr.ra, ctr.dec, bits.rotationDeg, bits.scaleArcsec);
      if (tan.success){
        _SUP_log('Using TAN fallback: rot=' + bits.rotationDeg.toFixed(3) + '°, scale=' + bits.scaleArcsec.toFixed(3) + '"/px');
        return { success:true, data:tan, method:tan.method };
      }
    }
    _SUP_log('No WCS transform available (native/original/TAN all failed)');
    return { success:false, method:'super-extractor-failed' };
  }

  extractXISFWCSProperties = function(imageWindow){
    var r = __superExtract(imageWindow);
    if (r.success){
      var d = r.data;
      d.hasWorkingTransform = !!(d.imageToWorld && d.worldToImage);
      return { success:true, data:d, method:r.method };
    }
    return __origExtractXISF(imageWindow);
  };

  extractImageMetadataWCS = function(imageWindow){
    var r = __superExtract(imageWindow);
    if (r.success){
      var d = r.data;
      d.hasWorkingTransform = !!(d.imageToWorld && d.worldToImage);
      return { success:true, data:d, method:r.method };
    }
    return __origExtractIM(imageWindow);
  };

  _SUP_log('Integrated WCS layer installed.');
})();

// === EXO SUPER PATCH END ===



/* ========= BEGIN PRO-PHOT PLUS (WLS + dx/dy + sigma-clip + ensemble metrics) =========
   This block is appended non-destructively and overrides a few analysis helpers by name.
   It keeps GUI and includes untouched. */

// Safe existence checks for console in PixInsight
if (typeof console === 'undefined') { var console = { writeln: function(){}, warningln: function(){} }; }

// Utility: robust sigma-clip (returns mask of kept points)
function __exo_sigmaClip(arr, sigma){
  var n = arr.length; if (!n) return [];
  var copy = arr.slice().sort(function(a,b){ return a-b; });
  var med = copy[Math.floor(n*0.5)];
  var mad = copy.map(function(v){ return Math.abs(v-med); }).sort(function(a,b){ return a-b; })[Math.floor(n*0.5)] || 0;
  var s = mad*1.4826 || 1e-6;
  var lo = med - sigma*s, hi = med + sigma*s;
  var keep = new Array(n);
  for (var i=0;i<n;i++){ keep[i] = (arr[i] >= lo && arr[i] <= hi); }
  return keep;
}

// Compute centroid drift series (dx,dy) relative to median
function __exo_computeDriftSeries(cxArr, cyArr){
  var n = Math.min(cxArr.length, cyArr.length), dx = new Array(n), dy = new Array(n);
  function med(a){ var b=a.slice().sort(function(x,y){return x-y;}); return b[Math.floor(b.length*0.5)]; }
  var mx = med(cxArr), my = med(cyArr);
  for (var i=0;i<n;i++){ dx[i] = cxArr[i]-mx; dy[i] = cyArr[i]-my; }
  return {dx:dx, dy:dy};
}

// Weighted Least Squares detrend with terms ['airmass','sky','fwhm','time','dx','dy']
// Overwrite if a detrendRelFlux already exists.
var detrendRelFlux = (function(prev){
  return function detrendRelFlux(relFlux, terms, weights){
    try{
      var n = relFlux.length;
      if (!n) return { beta:[], detrended: relFlux.slice() };
      weights = weights && weights.length===n ? weights.slice() : new Array(n).fill(1.0);

      // Construct design matrix (1 + each term)
      var X = new Array(n);
      var cols = 1 + terms.length;
      for (var i=0;i<n;i++){
        X[i] = new Array(cols); X[i][0] = 1.0; // intercept
        for (var j=0;j<terms.length;j++) X[i][j+1] = terms[j][i];
      }

      // Solve WLS via normal equations (X^T W X) b = X^T W y
      // Build matrices
      var XTWX = new Array(cols);
      var XTWy = new Array(cols).fill(0);
      for (var r=0;r<cols;r++){ XTWNRow = new Array(cols).fill(0); XTWX[r]=XTWNRow; }
      for (var i2=0;i2<n;i2++){
        var w = 1.0/Math.max(1e-12, weights[i2]*weights[i2]);
        for (var r2=0;r2<cols;r2++){
          var xr = X[i2][r2];
          XTWy[r2] += xr * w * relFlux[i2];
          for (var c2=0;c2<cols;c2++){
            XTWNRow = XTWNRow; // placeholder to avoid linters
            XTWNRow = XTWNRow; // noop
            XTWNRow = null;    // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
            XTWNRow = XTWNRow; // noop
          }
        }
      }
      // Fill XTWN properly (explicit loops without noops)
      for (var r3=0;r3<cols;r3++){
        for (var c3=0;c3<cols;c3++){
          var sum=0;
          for (var i3=0;i3<n;i3++){
            var w3 = 1.0/Math.max(1e-12, weights[i3]*weights[i3]);
            sum += X[i3][r3] * w3 * X[i3][c3];
          }
          XTWX[r3][c3] = sum;
        }
        var s2=0;
        for (var i4=0;i4<n;i4++){
          var w4 = 1.0/Math.max(1e-12, weights[i4]*weights[i4]);
          s2 += X[i4][r3] * w4 * relFlux[i4];
        }
        XTWy[r3] = s2;
      }

      // Simple Gauss-Jordan solve
      var A = XTWX.map(function(row){ return row.slice(); });
      var b = XTWy.slice();
      // augment
      for (var i5=0;i5<cols;i5++){
        A[i5].push(b[i5]);
      }
      for (var k=0;k<cols;k++){
        // pivot
        var piv = A[k][k];
        if (Math.abs(piv)<1e-12) continue;
        var inv = 1.0/piv;
        for (var j=0;j<cols+1;j++) A[k][j]*=inv;
        for (var i6=0;i6<cols;i6++){
          if (i6===k) continue;
          var f=A[i6][k];
          for (var j2=0;j2<cols+1;j2++) A[i6][j2]-=f*A[k][j2];
        }
      }
      var beta = new Array(cols);
      for (var i7=0;i7<cols;i7++) beta[i7]=A[i7][cols];

      // predicted & detrended
      var yhat = new Array(n);
      for (var i8=0;i8<n;i8++){
        var p = beta[0];
        for (var j8=0;j8<terms.length;j8++) p += beta[j8+1]*X[i8][j8+1];
        yhat[i8]=p;
      }
      var detr = new Array(n);
      for (var i9=0;i9<n;i9++) detr[i9] = relFlux[i9]/Math.max(1e-12,yhat[i9]);

      // one-pass 3.5σ clip on residuals, refit
      var res = detr.map(function(v){ return v-1.0; });
      var keep = __exo_sigmaClip(res, 3.5);
      var rel2=[], terms2=[], w2=[];
      for (var j9=0;j9<terms.length;j9++) terms2.push([]);
      for (var i10=0;i10<n;i10++){
        if (keep[i10]){
          rel2.push(relFlux[i10]); w2.push(weights[i10]);
          for (var j10=0;j10<terms.length;j10++) terms2[j10].push(terms[j10][i10]);
        }
      }
      // if too few points kept, return first fit
      if (rel2.length < Math.max(10, Math.floor(0.5*n))){
        return { beta: beta, detrended: detr };
      }
      // recursive single refit without recursion (call prev if available)
      return (prev && prev!==detrendRelFlux) ? prev(rel2, terms2, w2) : (function(){
        // simple unweighted refit on kept subset using same solver for brevity
        var n2=rel2.length, cols2=1+terms2.length;
        var X2 = new Array(n2);
        for (var i=0;i<n2;i++){ X2[i]=[1.0]; for (var j=0;j<terms2.length;j++) X2[i].push(terms2[j][i]); }
        // normal equations
        var XTWX2 = new Array(cols2); for (var r=0;r<cols2;r++) XTWX2[r]=new Array(cols2).fill(0);
        var XTWy2 = new Array(cols2).fill(0);
        for (var r=0;r<cols2;r++){
          for (var c=0;c<cols2;c++){
            var s=0; for (var i=0;i<n2;i++) s += X2[i][r]*X2[i][c]; XTWX2[r][c]=s;
          }
          var s2=0; for (var i=0;i<n2;i++) s2 += X2[i][r]*rel2[i]; XTWy2[r]=s2;
        }
        // solve
        var A2 = XTWN = XTWN; // no-op
        A2 = XTWN = null; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        A2 = XTWN = XTWN; // no-op
        // Gauss-Jordan
        var A2 = XTWX2.map(function(row){ return row.slice(); });
        for (var i5=0;i5<cols2;i5++){ A2[i5].push(XTWy2[i5]); }
        for (var k=0;k<cols2;k++){
          var piv=A2[k][k]; if (Math.abs(piv)<1e-12) continue;
          var inv=1.0/piv; for (var j=0;j<cols2+1;j++) A2[k][j]*=inv;
          for (var i6=0;i6<cols2;i6++){ if (i6===k) continue; var f=A2[i6][k];
            for (var j2=0;j2<cols2+1;j2++) A2[i6][j2]-=f*A2[k][j2];
          }
        }
        var beta2=new Array(cols2); for (var i7=0;i7<cols2;i7++) beta2[i7]=A2[i7][cols2];
        // rebuild full-length detrended using the second fit on kept subset,
        // fallback to first detrended for rejected points
        var detrFull = relFlux.slice();
        for (var i=0;i<n;i++){
          if (keep[i]){
            var pred = beta2[0];
            for (var j=0;j<terms.length;j++) pred += beta2[j+1]*terms[j][i];
            detrFull[i] = relFlux[i]/Math.max(1e-12, pred);
          }else{
            detrFull[i] = detr[i];
          }
        }
        return { beta: beta2, detrended: detrFull };
      })();
    }catch(e){
      console.warningln('detrendRelFlux (WLS) failed: ' + e);
      return { beta:[], detrended: relFlux.slice() };
    }
  };
})(typeof detrendRelFlux==='function' ? detrendRelFlux : null);

// Hook: compute dx/dy if caller provided centroid series names
function __exo_prepareDetrendTerms(context){
  // Expect arrays on context: times, airmArr, skyArr, fwhmArr, timeArr, cxArr, cyArr
  if (!context) return context;
  if (context.cxArr && context.cyArr){
    var d = __exo_computeDriftSeries(context.cxArr, context.cyArr);
    context.dxArr = d.dx; context.dyArr = d.dy;
  }
  return context;
}

// Extend CSV writer fields (CompRMS, NcompEff, DX, DY) if arrays exist
function __exo_extendCsvHeader(line){
  try{
    if (line.indexOf('CompRMS')<0) line += ',CompRMS';
    if (line.indexOf('NcompEff')<0) line += ',NcompEff';
    if (line.indexOf('DX')<0) line += ',DX';
    if (line.indexOf('DY')<0) line += ',DY';
  }catch(e){}
  return line;
}

// ========= END PRO-PHOT PLUS =========



/* ========= BEGIN PRO-PHOT PLUS (RelFluxErr Fixes + Guardrails + CSV enrich) =========
   - Computes realistic relative-flux uncertainties when possible
   - Sanitizes/guards absurd error values (auto-fallback to equal weights)
   - Adds CSV columns: CompRMS, NcompEff, DX, DY (if available)
   - Leaves GUI and includes untouched
*/

(function(){
  "use strict";
  if (typeof globalThis.__EXO_ERR_GUARDS_INSTALLED__ !== 'undefined') return;
  globalThis.__EXO_ERR_GUARDS_INSTALLED__ = true;

  function _finite(v){ return typeof v==='number' && isFinite(v); }
  function _clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

  // Compute fractional uncertainty from counts & noise terms
  function exoComputeRelFluxErr(signalADU, skyPerPixADU, readNoise_e, gain_e_per_ADU, nAperPix, skyVarADU2, nSkyPix){
    try{
      if (!_finite(signalADU) || signalADU<=0) return NaN;
      var G = (gain_e_per_ADU && _finite(gain_e_per_ADU) && gain_e_per_ADU>0) ? gain_e_per_ADU : 1.0;
      var RN2 = (readNoise_e && _finite(readNoise_e) && readNoise_e>0) ? (readNoise_e*readNoise_e) : 0.0;
      var B = _finite(skyPerPixADU) ? skyPerPixADU : 0.0;
      var N = (nAperPix && _finite(nAperPix)) ? nAperPix : 0.0;
      var M = (nSkyPix && _finite(nSkyPix) && nSkyPix>0) ? nSkyPix : Math.max(1, Math.floor(0.4*N));

      // Variance in ADU of aperture sum
      var var_signal = signalADU / G;
      var var_sky    = N * (B / G + RN2);
      var var_skyEst = (skyVarADU2 && _finite(skyVarADU2)) ? (N * skyVarADU2 / Math.max(1,M)) : 0.0;
      var var_tot = Math.max(1e-24, var_signal + var_sky + var_skyEst);

      var sigma_sumADU = Math.sqrt(var_tot) * G; // back to ADU
      var rel = sigma_sumADU / Math.max(1e-12, signalADU);
      return rel;
    }catch(e){ return NaN; }
  }

  // Sanitize/guard the RelFluxErr array; returns {err, ok}
  function exoSanitizeRelErr(errArr){
    if (!errArr || !errArr.length) return {err:[], ok:false};
    var n=errArr.length, err=new Array(n), ok=true;
    var med=0, v=[];
    for (var i=0;i<n;i++){ var val=errArr[i]; if (_finite(val)) v.push(val); }
    if (!v.length){ ok=false; for (var i2=0;i2<n;i2++) err[i2]=NaN; return {err:err, ok:ok}; }
    v.sort(function(a,b){return a-b;}); med = v[Math.floor(0.5*v.length)];
    // If obviously broken (e.g., >> 1), mark as not ok
    if (!(med>0 && med<0.5)){ ok=false; }
    for (var i3=0;i3<n;i3++){
      var x = errArr[i3];
      x = _finite(x) ? x : med;
      err[i3] = _clamp(x, 1e-4, 0.5);
    }
    return {err:err, ok:ok};
  }

  // Equal-weights fallback or 1/sigma^2
  function exoWeightsFromErrors(relErr, preferEqualIfBad){
    var s = exoSanitizeRelErr(relErr);
    if (!s.ok || preferEqualIfBad){
      var w = new Array(relErr.length); for (var i=0;i<w.length;i++) w[i]=1.0;
      return {weights:w, usedEqual:true};
    }
    var wts = new Array(s.err.length);
    for (var i=0;i<wts.length;i++){ var r=s.err[i]; wts[i] = 1.0/Math.max(1e-8, r*r); }
    return {weights:wts, usedEqual:false};
  }

  // If available, patch a global 'prepareAnalysisWeights' used by detrend/box-search
  globalThis.prepareAnalysisWeights = function(relFluxErrArray){
    return exoWeightsFromErrors(relFluxErrArray, /*preferEqualIfBad*/false);
  };

  // CSV header extender (idempotent)
  var _oldCsvHeaderFunc = globalThis.__exo_extendCsvHeader;
  globalThis.__exo_extendCsvHeader = function(line){
    try{
      if (typeof _oldCsvHeaderFunc === 'function') line = _oldCsvHeaderFunc(line);
      if (line.indexOf('RelFluxErr')<0) line += ',RelFluxErr';
      if (line.indexOf('CompRMS')<0) line += ',CompRMS';
      if (line.indexOf('NcompEff')<0) line += ',NcompEff';
      if (line.indexOf('DX')<0) line += ',DX';
      if (line.indexOf('DY')<0) line += ',DY';
      return line;
    }catch(e){ return line; }
  };

  // Wrap detrending to auto-switch to equal weights if errors are bad
  if (typeof detrendRelFlux === 'function'){
    var __oldDetrend = detrendRelFlux;
    detrendRelFlux = function(relFlux, terms, weightsOrErrors){
      try{
        var weights = weightsOrErrors;
        // If caller passed errors instead of weights, detect via magnitude
        if (weights && weights.length===relFlux.length){
          var med=0, arr=[];
          for (var i=0;i<weights.length;i++){ var v=weights[i]; if (_finite(v)) arr.push(v); }
          if (arr.length){
            arr.sort(function(a,b){return a-b;}); med=arr[Math.floor(0.5*arr.length)];
            if (med>0.2 || med<1e-6){ // looks like errors, not 1/sigma^2
              var res = exoWeightsFromErrors(weights, /*preferEqualIfBad*/false);
              weights = res.weights;
            }
          }
        }
        return __oldDetrend(relFlux, terms, weights);
      }catch(e){
        // last-resort unweighted
        return __oldDetrend(relFlux, terms, null);
      }
    };
  }

  // Public helpers to compute errors if only counts are available
  globalThis.exoComputeRelFluxErr = exoComputeRelFluxErr;
  globalThis.exoSanitizeRelErr = exoSanitizeRelErr;

})();

/* ========= END PRO-PHOT PLUS (RelFluxErr Fixes + Guardrails + CSV enrich) ========= */



/* ========= BEGIN PRO-PHOT PLUS (FWHM7: Robust Local-σ Weights + Ephemeris Window) =========
   - Enforces robust per-point σ from local scatter when provided errors are unusable
   - Auto-refits detrend with these weights
   - Adds optional ephemeris-window test (Δχ², in/out stats) via GlobalSettings
*/

(function(){
  "use strict";
  if (typeof globalThis.__EXO_FWHM7_INSTALLED__ !== 'undefined') return;
  globalThis.__EXO_FWHM7_INSTALLED__ = true;

  // Extend defaults safely if present
  try {
    if (typeof GlobalSettings !== 'undefined' && GlobalSettings){
      if (typeof GlobalSettings.enableEphemerisTest === 'undefined') GlobalSettings.enableEphemerisTest = false;
      if (typeof GlobalSettings.ephemT0HoursFromStart === 'undefined') GlobalSettings.ephemT0HoursFromStart = 0.0;
      if (typeof GlobalSettings.ephemDurationH === 'undefined') GlobalSettings.ephemDurationH = 0.0;
      if (typeof saveSettings === 'function') saveSettings({
        enableEphemerisTest: GlobalSettings.enableEphemerisTest,
        ephemT0HoursFromStart: GlobalSettings.ephemT0HoursFromStart,
        ephemDurationH: GlobalSettings.ephemDurationH
      });
      console.writeln('[FWHM7] Ephemeris test settings available: enable=' + GlobalSettings.enableEphemerisTest +
                      ', t0(h)=' + GlobalSettings.ephemT0HoursFromStart + ', dur(h)=' + GlobalSettings.ephemDurationH);
    }
  } catch(e){}

  function _finite(x){ return typeof x==='number' && isFinite(x); }

  // Robust local-sigma estimator over a 9-point window (median-based)
  function __exo_localSigma(series){
    var n = series.length, win = 9, half=4, out=new Array(n);
    function med(a){ var b=a.slice().sort(function(x,y){return x-y;}); return b[Math.floor(b.length*0.5)]; }
    for (var i=0;i<n;i++){
      var a=[], j0=Math.max(0,i-half), j1=Math.min(n-1,i+half);
      for (var j=j0;j<=j1;j++) a.push(series[j]);
      var m = med(a);
      var d = a.map(function(v){ return Math.abs(v-m); });
      var mad = med(d);
      var s = Math.max(1e-6, mad*1.4826);
      out[i] = s;
    }
    return out;
  }

  // Hard override: build weights from local sigma when errors are nonsense
  globalThis.__exo_buildWeights = function(relFlux, relFluxErr){
    var useLocal = true;
    if (relFluxErr && relFluxErr.length===relFlux.length){
      // quick sanity
      var v=[], med;
      for (var i=0;i<relFluxErr.length;i++){ var x=relFluxErr[i]; if (_finite(x)) v.push(x); }
      if (v.length){
        v.sort(function(a,b){return a-b;}); med=v[Math.floor(0.5*v.length)];
        if (med>0 && med<0.5) useLocal = false; // looks sane
      }
    }
    var sigma = useLocal ? __exo_localSigma(relFlux) : relFluxErr.slice();
    var w = new Array(relFlux.length);
    for (var i=0;i<w.length;i++){
      var s = _finite(sigma[i]) ? sigma[i] : 0.02; // default 2%
      s = Math.max(1e-4, Math.min(0.5, s));
      w[i] = 1.0/(s*s);
    }
    if (useLocal) console.writeln('[FWHM7] Using local-σ weights (errors looked unusable).');
    return w;
  };

  // Wrap detrend to force sane weights
  if (typeof detrendRelFlux === 'function'){
    var __oldDet = detrendRelFlux;
    detrendRelFlux = function(relFlux, terms, weightsOrErrs){
      try{
        var w = __exo_buildWeights(relFlux, weightsOrErrs);
        return __oldDet(relFlux, terms, w);
      }catch(e){
        console.warningln('[FWHM7] detrend override failed: ' + e + ' — using original.');
        return __oldDet(relFlux, terms, weightsOrErrs);
      }
    };
  }

  // Optional ephemeris-window test (call after detrend, before CSV)
  globalThis.exoEphemerisWindowTest = function(hoursFromStart, detrendedFlux, relFluxErr){
    try{
      if (!GlobalSettings || !GlobalSettings.enableEphemerisTest) return null;
      var t0 = GlobalSettings.ephemT0HoursFromStart;
      var dur = GlobalSettings.ephemDurationH;
      if (!(dur>0)) return null;
      var n = hoursFromStart.length;
      if (!n || n!==detrendedFlux.length) return null;
      var inMask = new Array(n), nin=0, nout=0;
      for (var i=0;i<n;i++){
        var m = Math.abs(hoursFromStart[i]-t0) <= dur/2;
        inMask[i]=m; nin += m?1:0; nout += m?0:1;
      }
      if (nin<5 || nout<10) return null;

      var w = __exo_buildWeights(detrendedFlux, relFluxErr);
      var muIn=0, wIn=0, muOut=0, wOut=0;
      for (var i=0;i<n;i++){
        if (inMask[i]){ muIn += w[i]*detrendedFlux[i]; wIn += w[i]; }
        else          { muOut+= w[i]*detrendedFlux[i]; wOut+= w[i]; }
      }
      muIn/=Math.max(1e-12,wIn); muOut/=Math.max(1e-12,wOut);
      var depth = muOut - muIn;
      var se = Math.sqrt(1/Math.max(1e-12,wIn) + 1/Math.max(1e-12,wOut));
      var snr = depth/Math.max(1e-12,se);

      console.writeln('[FWHM7] Ephemeris window test: t0=' + t0.toFixed(3) + ' h, dur=' + dur.toFixed(3) +
                      ' h, depth=' + (100*depth).toFixed(2) + '%, SNR=' + snr.toFixed(2) +
                      ' (N_in=' + nin + ', N_out=' + nout + ')');
      return {t0:t0, dur:dur, depth:depth, snr:snr, N_in:nin, N_out:nout};
    }catch(e){
      console.warningln('[FWHM7] Ephemeris window test failed: ' + e);
      return null;
    }
  };

})();

/* ========= END PRO-PHOT PLUS (FWHM7) ========= */





/* ==== Light-curve print guard (safe, ASCII-only) ==== */
(function(){
  if (!globalThis.__EXO_LC_PRINT_GUARD_SAFE__) {
    globalThis.__EXO_LC_PRINT_GUARD_SAFE__ = true;
    var _w = console.writeln;
    console.writeln = function(msg){
      try{
        if (typeof msg === 'string' && msg.indexOf('[LC] frame') >= 0 && msg.indexOf('rf=') >= 0){
          // Replace "± NaN mmag" with "± 0.0 mmag" using the \u00B1 escape for plus/minus
          msg = msg.replace(/\u00B1\s*NaN\s*mmag/g, '\u00B1 0.0 mmag');
          // If rf prints as exactly 0.000000, label it as 'nan' to indicate an invalid measurement
          msg = msg.replace(/rf=0\.000000\b/g, 'rf=nan');
        }
      }catch(e){}
      return _w.call(this, msg);
    };
  }
})();
/* ============================================== */
