// =========================================================================
// GradientInspector.js
// =========================================================================
// Runs multiple gradient removal tools on a single image and produces
// a side-by-side comparison mosaic: corrected image top, gradient model bottom.
//
// Tools supported:
//   GradientCorrection (GC)
//   MultiscaleGradientCorrection (MGC)
//   DynamicBackgroundExtraction (DBE)
//   GraXpert
//   AutoDBE (Franklin Marek / Seti Astro — CC BY-NC 4.0, adapted with attribution)
//
// Author: Brannon Quel
// Copyright (C) 2026 Brannon Quel
// Version: 1.0
// =========================================================================
//   1.0  2026  Initial release

#engine v8

#feature-id    GradientInspector : PhotonDumpsterFire > GradientInspector
#feature-icon  GradientInspector.svg
#feature-info  Runs multiple gradient removal tools and generates a side-by-side comparison mosaic.

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

var SCRIPT_VERSION = "1.0";
var SCRIPT_TITLE   = "GradientInspector";

// =========================================================================
// AutoDBE functions — adapted from AutoDBE v1.6 by Franklin Marek
// www.setiastro.com — CC BY-NC 4.0
// =========================================================================

function gi_enumValue( obj, name, fallback ) {
   try { var v = obj[name]; if ( typeof v === "number" && isFinite(v) ) return v|0; } catch(e) {}
   return fallback;
}

var GI_ABE_SUBTRACT = gi_enumValue( AutomaticBackgroundExtractor, "Subtract", 0 );
var GI_DBE_SUBTRACT = gi_enumValue( DynamicBackgroundExtraction,  "Subtract", 0 );
var GI_BN_RESCALE   = gi_enumValue( BackgroundNeutralization, "RescaleAsNeeded", 0 );

function gi_isOverlapping( r1, r2 ) {
   return !( r1.x1 < r2.x0 || r1.x0 > r2.x1 || r1.y1 < r2.y0 || r1.y0 > r2.y1 );
}

function gi_calculate_window_size( h ) {
   return Math.min( Math.round( h * 0.015 ), 30 );
}

function gi_calculate_spacing( ws ) { return Math.ceil( ws * 0.5 ); }

function gi_get_average_pixel_brightness( img, x, y, ch ) {
   if ( ch == 1 ) return img.sample( x, y, 0 );
   return ( img.sample(x,y,0) + img.sample(x,y,1) + img.sample(x,y,2) ) / 3;
}

function gi_get_window_stats( img, x, y, ws, ch, tol ) {
   var pv = []; for (var c=0;c<ch;c++) pv.push([]);
   for (var ox=0;ox<ws;ox++) for (var oy=0;oy<ws;oy++) for (var c=0;c<ch;c++)
      pv[c].push( img.sample(x+ox,y+oy,c) );
   var avg=[],sd=[],med=[];
   for (var c=0;c<ch;c++) {
      var mn = pv[c].reduce(function(a,b){return a+b;},0)/pv[c].length;
      var vr = pv[c].reduce(function(a,b){return a+Math.pow(b-mn,2);},0)/pv[c].length;
      var sg = Math.sqrt(vr);
      var fv = pv[c].filter(function(v){return Math.abs(v-mn)<=tol*sg;});
      var nm = fv.reduce(function(a,b){return a+b;},0)/fv.length;
      fv.sort(function(a,b){return a-b;});
      avg.push(nm); sd.push(Math.sqrt(fv.reduce(function(a,b){return a+Math.pow(b-nm,2);},0)/fv.length));
      med.push(fv[Math.floor(fv.length/2)]);
   }
   return { average:avg, stddev:sd, median:med };
}

function gi_generate_starting_points( iw, ih, ws, np, img, ch, excl ) {
   var pts=[]; var qw=Math.floor(iw/2); var qh=Math.floor(ih/2); var sr=100;
   var quads=[{sx:0,sy:0},{sx:qw,sy:0},{sx:0,sy:qh},{sx:qw,sy:qh}];
   var ppq=Math.ceil(np/quads.length);
   for (var qi=0;qi<quads.length;qi++) {
      var q=quads[qi]; var gb=[];
      for (var x=q.sx;x<q.sx+qw;x+=sr) for (var y=q.sy;y<q.sy+qh;y+=sr) {
         var reg={x0:x,y0:y,x1:x+sr,y1:y+sr};
         if (excl.some(function(e){return gi_isOverlapping(reg,e);})) continue;
         var ab=0,cnt=0;
         for (var dx=0;dx<sr&&(x+dx)<iw;dx++) for (var dy=0;dy<sr&&(y+dy)<ih;dy++) {
            ab+=gi_get_average_pixel_brightness(img,x+dx,y+dy,ch); cnt++;
         }
         if (cnt>0) gb.push({x:x,y:y,avg:ab/cnt});
      }
      gb.sort(function(a,b){return a.avg-b.avg;});
      var fr=gb.slice(0,Math.floor(gb.length*2/3));
      fr.sort(function(){return Math.random()-0.5;});
      fr.slice(0,ppq).forEach(function(r){
         var px=Math.min(Math.floor(r.x+Math.random()*(sr-ws)),iw-ws);
         var py=Math.min(Math.floor(r.y+Math.random()*(sr-ws)),ih-ws);
         var pt={x0:px,y0:py,x1:px+ws,y1:py+ws};
         if (!excl.some(function(e){return gi_isOverlapping(pt,e);})) pts.push({x:px,y:py});
      });
   }
   if (pts.length>np) pts=pts.slice(0,np);
   return pts;
}

function gi_find_best_window( img, sx, sy, ws, sp, ch, tol ) {
   var bw={average:[],stddev:[],mean:[],x:sx,y:sy};
   for (var c=0;c<ch;c++){bw.average.push(1e9);bw.stddev.push(1e9);bw.mean.push(1e9);}
   var cx=sx,cy=sy,improved=true;
   while (improved) {
      improved=false;
      for (var ox=-1;ox<=1;ox++) for (var oy=-1;oy<=1;oy++) {
         var nx=cx+ox*sp, ny=cy+oy*sp;
         if (nx>=0&&nx+ws<=img.width&&ny>=0&&ny+ws<=img.height) {
            var st=gi_get_window_stats(img,nx,ny,ws,ch,tol);
            if (st.average.reduce(function(a,b){return a+b;},0)<bw.mean.reduce(function(a,b){return a+b;},0)) {
               bw={average:st.average,stddev:st.stddev,mean:st.average,x:nx,y:ny};
               improved=true;
            }
         }
      }
      cx=bw.x; cy=bw.y;
   }
   return bw;
}

function gi_calc_median( vals ) {
   vals.sort(function(a,b){return a-b;}); var h=Math.floor(vals.length/2);
   return vals.length%2?vals[h]:(vals[h-1]+vals[h])/2;
}

function gi_calc_mad( vals, med ) {
   return gi_calc_median( vals.map(function(v){return Math.abs(v-med);}) );
}

function gi_noise_weight( avg, med, mad ) {
   if (!Array.isArray(avg)) avg=[avg,avg,avg];
   if (!Array.isArray(med)) med=[med,med,med];
   if (!Array.isArray(mad)) mad=[mad,mad,mad];
   return avg.map(function(a,i){
      var m=med[i]||0.0001; var nf=1-(mad[i]/m);
      return Math.max(0,Math.min(1,nf));
   });
}

function gi_spatial_weight( x, y, w, h ) {
   var cx=w/2,cy=h/2;
   var d=Math.sqrt(Math.pow(x-cx,2)+Math.pow(y-cy,2));
   var md=Math.sqrt(cx*cx+cy*cy);
   var nd=d/md; var cw=0.95+0.05*nd;
   var etx=w*0.1,ety=h*0.1;
   var ew=(x<etx||x>w-etx||y<ety||y>h-ety)?0.95:1.0;
   return cw*ew;
}

function gi_getAllWindowIds() {
   var ids=[];
   for (var i=0;i<ImageWindow.windows.length;i++) ids.push(ImageWindow.windows[i].mainView.id);
   return ids;
}

function gi_closeWindowById( id ) {
   var w=ImageWindow.windowById(id);
   if (w&&!w.isNull) w.forceClose();
}

function gi_runAutoDBE( srcView ) {
   // Returns { correctedId, modelId } or throws on failure
   // Adapted from AutoDBE v1.6 by Franklin Marek (CC BY-NC 4.0)
   var img = srcView.image;
   var ch  = img.numberOfChannels;
   var ws  = gi_calculate_window_size( img.height );
   var sp  = gi_calculate_spacing( ws );
   var tol = 2.0;
   var excl = [];

   // Clone source
   var existingIds = gi_getAllWindowIds();
   var cloneId = srcView.id + "_GI_ADBE";
   var cloneWin = new ImageWindow( img.width, img.height, ch, img.bitsPerSample, img.isReal, img.isColor );
   cloneWin.mainView.beginProcess( UndoFlag.NoSwapFile );
   cloneWin.mainView.image.assign( img );
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = cloneId;
   if ( srcView.window.hasAstrometricSolution ) cloneWin.copyAstrometricSolution( srcView.window );
   cloneWin.keywords = srcView.window.keywords;
   cloneWin.show();

   var targetView = cloneWin.mainView;
   var sourceImage = targetView.image;

   // BN for color
   if ( ch > 1 ) {
      var bn = new BackgroundNeutralization;
      bn.backgroundReferenceViewId = "";
      bn.backgroundLow  = 0.0;
      bn.backgroundHigh = 0.12;
      bn.useROI = false;
      bn.mode   = GI_BN_RESCALE;
      bn.targetBackground = 0.001;
      bn.executeOn( targetView );
   }

   // ABE initial model
   var winsBeforeABE = gi_getAllWindowIds();
   var abeModelWin = null;
   var abe = new AutomaticBackgroundExtractor;
   abe.tolerance=1.0; abe.deviation=0.8; abe.unbalance=1.8;
   abe.minBoxFraction=0.05; abe.maxBackground=1.0; abe.minBackground=0.0;
   abe.useBrightnessLimits=false; abe.polyDegree=1; abe.boxSize=5;
   abe.boxSeparation=5; abe.abeDownsample=2.0; abe.writeSampleBoxes=false;
   abe.justTrySamples=false; abe.targetCorrection=GI_ABE_SUBTRACT;
   abe.normalize=false; abe.discardModel=false; abe.replaceTarget=true;
   abe.correctedImageId=""; abe.executeOn( targetView );
   var winsAfterABE = gi_getAllWindowIds();
   for (var i=0;i<winsAfterABE.length;i++) {
      if (winsBeforeABE.indexOf(winsAfterABE[i])===-1) {
         abeModelWin = ImageWindow.windowById(winsAfterABE[i]); break;
      }
   }
   if (abeModelWin) abeModelWin.hide();

   // Gradient descent
   var img_med = sourceImage.median();
   var img_std = sourceImage.stdDev();
   var threshold = img_med + 0.3*img_std;
   var max_threshold = img_med + 0.15*img_std;

   var np=50;
   var edge_points=[
      {x:10,y:10},{x:img.width-ws-10,y:10},
      {x:10,y:img.height-ws-10},{x:img.width-ws-10,y:img.height-ws-10},
      {x:img.width/2-ws/2,y:10},{x:img.width/2-ws/2,y:img.height-ws-10},
      {x:10,y:img.height/2-ws/2},{x:img.width-ws-10,y:img.height/2-ws/2},
      {x:img.width/4-ws/2,y:10},{x:3*img.width/4-ws/2,y:10},
      {x:img.width/4-ws/2,y:img.height-ws-10},{x:3*img.width/4-ws/2,y:img.height-ws-10}
   ];
   var rand_pts = gi_generate_starting_points( img.width, img.height, ws, np, sourceImage, ch, excl );
   var all_pts = edge_points.concat( rand_pts );

   var endPoints=[]; var bestWin=null; var finalBrightnesses=[];

   function isInExcl(x,y) {
      for (var i=0;i<excl.length;i++) if(x>=excl[i].x0&&x<=excl[i].x1&&y>=excl[i].y0&&y<=excl[i].y1) return true;
      return false;
   }

   function runDescent( thresh, maxT, pts ) {
      for (var i=0;i<pts.length;i++) {
         var sp2=pts[i];
         if (isInExcl(sp2.x,sp2.y)) continue;
         var attempts=0;
         while (gi_get_window_stats(sourceImage,sp2.x,sp2.y,ws,ch,tol).average.some(function(a){return a>=thresh;})&&attempts<10) {
            var rx=Math.floor(Math.random()*(img.width-ws));
            var ry=Math.floor(Math.random()*(img.height-ws));
            sp2={x:rx,y:ry}; attempts++;
         }
         var bw=gi_find_best_window(sourceImage,sp2.x,sp2.y,ws,sp,ch,tol);
         if (!bw.average.some(function(a){return a>maxT;})) {
            if (!bestWin||bw.average.reduce(function(a,b){return a+b;},0)<bestWin.average.reduce(function(a,b){return a+b;},0))
               bestWin=bw;
            var rb=bw.average.reduce(function(a,b){return a+b;},0)/ch;
            finalBrightnesses.push(rb);
            var med3=Array.isArray(img_med)?img_med:[img_med,img_med,img_med];
            var mad3=[0,0,0];
            endPoints.push({x:bw.x,y:bw.y,average:bw.average,mad:mad3,weights:gi_noise_weight(bw.average,med3,mad3)});
         }
      }
   }

   runDescent(threshold,max_threshold,all_pts);
   if (!bestWin) { threshold=2*img_med; max_threshold=img_med+2*img_std; runDescent(threshold,max_threshold,all_pts); }
   if (!bestWin) throw new Error("AutoDBE: all starting points rejected.");

   var med_b=gi_calc_median(finalBrightnesses);
   var mad_b=gi_calc_mad(finalBrightnesses,med_b);
   var norm_mad=15*1.4826*mad_b/(img_med||0.0001);
   var sf=Math.max(0.15,Math.min(0.5,0.15+(0.5-0.15)*(1-norm_mad)));

   var med3=Array.isArray(img_med)?img_med:[img_med,img_med,img_med];
   var std3=Array.isArray(img_std)?img_std:[img_std,img_std,img_std];
   while (endPoints.length<3) endPoints.push({x:Math.random()*(img.width-ws),y:Math.random()*(img.height-ws),average:med3.slice(),mad:[0,0,0]});

   // Execute DBE
   var winsBeforeDBE = gi_getAllWindowIds();
   var P = new DynamicBackgroundExtraction;
   P.data = endPoints.map(function(pt){
      var avg=pt.average.slice(); var mad=pt.mad.slice();
      if(avg.length<3){avg=[avg[0],avg[0],avg[0]];}
      if(mad.length<3){mad=[mad[0]||0,mad[0]||0,mad[0]||0];}
      var nw=gi_noise_weight(avg,med3,mad);
      var sw=gi_spatial_weight(pt.x,pt.y,img.width,img.height);
      var w0=nw[0]*sw, w1=(nw[1]||nw[0])*sw, w2=(nw[2]||nw[0])*sw;
      if(!isFinite(w0))w0=1; if(!isFinite(w1))w1=1; if(!isFinite(w2))w2=1;
      return [pt.x/img.width,pt.y/img.height,avg[0],w0,avg[1],w1,avg[2],w2];
   });
   P.samples = endPoints.map(function(pt){
      var avg=pt.average.slice(); var mad=pt.mad.slice();
      if(avg.length<3){avg=[avg[0],avg[0],avg[0]];}
      if(mad.length<3){mad=[mad[0]||0,mad[0]||0,mad[0]||0];}
      var nw=gi_noise_weight(avg,med3,mad);
      var sw=gi_spatial_weight(pt.x,pt.y,img.width,img.height);
      var w0=nw[0]*sw, w1=(nw[1]||nw[0])*sw, w2=(nw[2]||nw[0])*sw;
      if(!isFinite(w0))w0=1; if(!isFinite(w1))w1=1; if(!isFinite(w2))w2=1;
      return [pt.x,pt.y,ws/2,0,6,0,avg[0],w0,avg[1],w1,avg[2],w2];
   });
   P.numberOfChannels=3; P.derivativeOrder=2; P.smoothing=sf;
   P.ignoreWeights=false; P.modelId=""; P.modelWidth=0; P.modelHeight=0;
   P.downsample=2; P.targetCorrection=GI_DBE_SUBTRACT; P.normalize=true;
   P.discardModel=false; P.replaceTarget=true; P.correctedImageId="";
   P.imageWidth=img.width; P.imageHeight=img.height;
   P.symmetryCenterX=0.5; P.symmetryCenterY=0.5;
   P.tolerance=tol; P.shadowsRelaxation=5.0; P.minSampleFraction=0.05;
   P.defaultSampleRadius=ws/2; P.samplesPerRow=10; P.minWeight=0.4;
   P.executeOn( targetView );

   var winsAfterDBE = gi_getAllWindowIds();
   var dbeModelId = null;
   for (var i=0;i<winsAfterDBE.length;i++) {
      if (winsBeforeDBE.indexOf(winsAfterDBE[i])===-1) { dbeModelId=winsAfterDBE[i]; break; }
   }

   // Combine ABE + DBE models if both present
   var modelId = null;
   if (abeModelWin && dbeModelId) {
      var pm = new PixelMath;
      pm.expression = abeModelWin.mainView.id + " + " + dbeModelId;
      pm.useSingleExpression=true; pm.generateOutput=true;
      pm.createNewImage=true; pm.showNewImage=true;
      pm.newImageId="GI_ADBE_model"; pm.newImageWidth=0; pm.newImageHeight=0;
      pm.newImageAlpha=false; pm.newImageColorSpace=PixelMath.SameAsTarget;
      pm.newImageSampleFormat=PixelMath.SameAsTarget;
      pm.rescale=false; pm.truncate=true;
      pm.executeOn( ImageWindow.windowById(dbeModelId).mainView, false );
      gi_closeWindowById( abeModelWin.mainView.id );
      gi_closeWindowById( dbeModelId );
      modelId = "GI_ADBE_model";
   } else if (dbeModelId) {
      modelId = dbeModelId;
   }

   return { correctedId: cloneId, modelId: modelId };
}

// =========================================================================
// Auto-stretch helper — MTF stretch for normal images
// For model/gradient images (very flat, low median) use simple rescale
// =========================================================================
function gi_applySTF( view ) {
   var pm = new PixelMath;
   pm.useSingleExpression = true;
   pm.generateOutput = true;
   pm.singleThreaded = false;
   pm.optimization = true;
   pm.use64BitWorkingImage = false;
   pm.rescale = false;
   pm.truncate = true;
   pm.truncateLower = 0;
   pm.truncateUpper = 1;
   pm.createNewImage = false;
   pm.showNewImage = false;

   // Check if this is a near-flat gradient model image
   // If max - min range is very small, use simple linear rescale
   var img = view.image;
   var imgMax = img.maximum();
   var imgMin = img.minimum();
   var range = imgMax - imgMin;

   if ( range < 0.15 ) {
      // Linear rescale to full range — good for gradient model images
      pm.expression = "rescale($T,0,1)";
   } else {
      // Standard MTF stretch for corrected images
      pm.expression =
         "C = -2.8;" +
         "B = 0.20;" +
         "m = (med($T[0])+med($T[1])+med($T[2]))/3;" +
         "d = (mdev($T[0])+mdev($T[1])+mdev($T[2]))/3;" +
         "c = min(max(0,m+C*1.4826*d),1);" +
         "mtf(mtf(B,m-c),max(0,($T-c)/~c))";
      pm.symbols = "C,B,m,d,c";
   }
   pm.executeOn( view );
}

// =========================================================================
// Burn text label into mosaic image at (x,y) using VectorGraphics + Bitmap
// =========================================================================
function gi_burnLabel( mosaicImg, text, x, y, w, h, bgR, bgG, bgB ) {
   // Create a bitmap the size of the label bar
   var bmp = new Bitmap( w, h );
   bmp.fill( 0xff000000 ); // black initially

   // Fill background color
   var bgColor = (0xff << 24) | (Math.round(bgR*255) << 16) | (Math.round(bgG*255) << 8) | Math.round(bgB*255);
   bmp.fill( bgColor );

   // Draw text centered
   var g = new Graphics( bmp );
   g.antialiasing = true;
   g.font = new Font( FontFamily.SansSerif, 13 );
   g.font.bold = true;
   g.pen = new Pen( 0xffffffff );
   var tw = g.font.width( text );
   var th = g.font.ascent;
   var tx = Math.max( 4, Math.round( (w - tw) / 2 ) );
   var ty = Math.round( (h + th) / 2 ) - 2;
   g.drawText( tx, ty, text );
   g.end();

   // Copy bitmap pixels into mosaic image
   for (var by=0; by<h; by++) {
      for (var bx=0; bx<w; bx++) {
         var px = bmp.pixel( bx, by );
         var r = ((px >> 16) & 0xff) / 255;
         var gv = ((px >> 8)  & 0xff) / 255;
         var b  = ( px        & 0xff) / 255;
         mosaicImg.setSample( r,  x+bx, y+by, 0 );
         mosaicImg.setSample( gv, x+bx, y+by, 1 );
         mosaicImg.setSample( b,  x+bx, y+by, 2 );
      }
   }
}

// =========================================================================
// Apply unlinked auto-STF baked into pixels — mimics STF unlink + nuke button
// =========================================================================
function gi_applyUnlinkedSTF( view ) {
   // Normalize using global max across all channels — same scalar for all three
   // This preserves colour relationships while making the gradient visible
   var img = view.image;
   img.selectedChannel=0; var mx0=img.maximum();
   img.selectedChannel=1; var mx1=img.maximum();
   img.selectedChannel=2; var mx2=img.maximum();
   img.resetSelections();
   var gMax = Math.max(mx0, mx1, mx2);
   if (gMax < 1e-10) return;

   // Scale all channels by same factor so 0.25 target brightness
   var scale = 0.25 / gMax;
   var pm = new PixelMath;
   pm.expression = "$T * " + scale.toFixed(6);
   pm.useSingleExpression = true;
   pm.generateOutput = true;
   pm.rescale = false;
   pm.truncate = true;
   pm.createNewImage = false;
   pm.showNewImage = false;
   pm.executeOn( view );
}

// =========================================================================
// Mosaic builder — single composite, tools across columns
// Top row = corrected, bottom row = gradient model
// =========================================================================
function gi_buildMosaic( results, srcId ) {
   var TARGET_W  = 1200;  // target tile width per column
   var LABEL_H   = 28;   // label bar height
   var SEP       = 4;    // separator
   var nCols     = results.filter(function(r){return !r.failed;}).length;
   if (nCols===0) { console.warningln("  No successful results to mosaic."); return "none"; }

   // Get source dimensions from first valid result
   var srcW=1, srcH=1;
   for (var i=0;i<results.length;i++) {
      if (!results[i].failed && results[i].correctedId) {
         var tw = ImageWindow.windowById(results[i].correctedId);
         if (tw&&!tw.isNull) { srcW=tw.mainView.image.width; srcH=tw.mainView.image.height; break; }
      }
   }

   var factor = Math.max(1, Math.round(srcW/TARGET_W));
   var tileW  = Math.round(srcW/factor);
   var tileH  = Math.round(srcH/factor);
   var totalW = nCols*(tileW+SEP)+SEP;
   var totalH = LABEL_H+SEP + 2*(tileH+SEP);

   var mosaicId = "GradientInspector_Result";
   var counter=1;
   while (!ImageWindow.windowById(mosaicId).isNull)
      mosaicId = "GradientInspector_Result_"+(counter++);

   // Single creation — correct dimensions from the start
   var mosaicWin = new ImageWindow(totalW, totalH, 3, 32, true, true, mosaicId);
   mosaicWin.mainView.beginProcess();
   mosaicWin.mainView.image.fill(0.10);
   mosaicWin.mainView.endProcess();

   // Tool colors for label bars [R,G,B] 0-1
   var TOOL_COLORS = [
      [0.20,0.35,0.55],  // GC — blue
      [0.20,0.50,0.30],  // MGC — green
      [0.55,0.35,0.10],  // ABE — orange
      [0.45,0.20,0.55],  // GraXpert — purple
      [0.15,0.45,0.50],  // AutoDBE — teal
   ];

   // Helper: prepare tile in temp window, bake stretch, downsample, blit into mosaic
   function prepareBlit( winId, isModel, isAutoDBEModel, destX, destY ) {
      var sw = ImageWindow.windowById(winId);
      if (!sw||sw.isNull) return;
      var si = sw.mainView.image;
      var tmp = new ImageWindow(si.width, si.height, si.numberOfChannels, 32, true, si.isColor);
      tmp.mainView.beginProcess(UndoFlag.NoSwapFile);
      tmp.mainView.image.assign(si);
      tmp.mainView.endProcess();

      if (!isModel) {
         // Corrected images: per-channel MTF stretch
         var pm = new PixelMath;
         pm.generateOutput=true; pm.rescale=false; pm.truncate=true;
         pm.createNewImage=false; pm.showNewImage=false;
         pm.symbols="C,B,m,d,c";
         var nChC = tmp.mainView.image.numberOfChannels;
         if (nChC === 1) {
            pm.useSingleExpression = true;
            pm.expression = "C=-2.8;B=0.20;m=med($T);d=mdev($T);c=min(max(0,m+C*1.4826*d),1);mtf(mtf(B,m-c),max(0,($T-c)/~c))";
         } else {
            pm.useSingleExpression = false;
            pm.expression  = "C=-2.8;B=0.20;m=med($T[0]);d=mdev($T[0]);c=min(max(0,m+C*1.4826*d),1);mtf(mtf(B,m-c),max(0,($T[0]-c)/~c))";
            pm.expression1 = "C=-2.8;B=0.20;m=med($T[1]);d=mdev($T[1]);c=min(max(0,m+C*1.4826*d),1);mtf(mtf(B,m-c),max(0,($T[1]-c)/~c))";
            pm.expression2 = "C=-2.8;B=0.20;m=med($T[2]);d=mdev($T[2]);c=min(max(0,m+C*1.4826*d),1);mtf(mtf(B,m-c),max(0,($T[2]-c)/~c))";
         }
         pm.executeOn(tmp.mainView);
      }
      if (isModel) {
         var img3 = tmp.mainView.image;
         var nCh3 = img3.numberOfChannels;

         if (nCh3 === 1) {
            // Mono: simple min/max stretch
            img3.selectedChannel=0; var mn0=img3.minimum(); var mx0=img3.maximum();
            img3.resetSelections();
            var r0 = mx0-mn0 > 1e-10 ? (mx0-mn0) : 1;
            var pmM = new PixelMath;
            pmM.useSingleExpression=true;
            pmM.expression = "($T-"+mn0.toFixed(6)+")/"+r0.toFixed(6);
            pmM.generateOutput=true; pmM.rescale=false; pmM.truncate=true;
            pmM.createNewImage=false; pmM.showNewImage=false;
            pmM.executeOn(tmp.mainView);
         } else {
            // Colour: per-channel min/max — maximises gradient visibility per channel
            img3.selectedChannel=0; var mn0=img3.minimum(); var mx0=img3.maximum();
            img3.selectedChannel=1; var mn1=img3.minimum(); var mx1=img3.maximum();
            img3.selectedChannel=2; var mn2=img3.minimum(); var mx2=img3.maximum();
            img3.resetSelections();
            var r0 = mx0-mn0 > 1e-10 ? (mx0-mn0).toFixed(6) : "1";
            var r1 = mx1-mn1 > 1e-10 ? (mx1-mn1).toFixed(6) : "1";
            var r2 = mx2-mn2 > 1e-10 ? (mx2-mn2).toFixed(6) : "1";
            var pmM = new PixelMath;
            pmM.useSingleExpression = false;
            pmM.expression  = "($T[0]-"+mn0.toFixed(6)+")/"+r0;
            pmM.expression1 = "($T[1]-"+mn1.toFixed(6)+")/"+r1;
            pmM.expression2 = "($T[2]-"+mn2.toFixed(6)+")/"+r2;
            pmM.generateOutput=true; pmM.rescale=false; pmM.truncate=true;
            pmM.createNewImage=false; pmM.showNewImage=false;
            pmM.executeOn(tmp.mainView);
         }
      }
      // Corrected tiles already stretched above

      // Downsample to tileW x tileH
      if (tmp.mainView.image.width!==tileW || tmp.mainView.image.height!==tileH) {
         var rs = new Resample;
         rs.xSize = tileW/tmp.mainView.image.width;
         rs.ySize = tileH/tmp.mainView.image.height;
         rs.mode  = Resample.RelativeDimensions;
         rs.executeOn(tmp.mainView);
      }

      // Blit from live temp window
      var src   = tmp.mainView.image;
      var copyW = Math.min(src.width,  totalW-destX);
      var copyH = Math.min(src.height, totalH-destY);
      var nCh   = src.numberOfChannels;
      mosaicWin.mainView.beginProcess();
      var mi = mosaicWin.mainView.image;
      for (var y=0;y<copyH;y++)
         for (var x=0;x<copyW;x++) {
            mi.setSample(src.sample(x,y,0),         destX+x, destY+y, 0);
            mi.setSample(src.sample(x,y,nCh>1?1:0), destX+x, destY+y, 1);
            mi.setSample(src.sample(x,y,nCh>2?2:0), destX+x, destY+y, 2);
         }
      mosaicWin.mainView.endProcess();
      tmp.forceClose();
   }

      // Place tiles column by column
   var col = 0;
   for (var i=0;i<results.length;i++) {
      var r = results[i];
      if (r.failed) continue;

      var colX = SEP + col*(tileW+SEP);
      var colorIdx = i % TOOL_COLORS.length;
      var tc = TOOL_COLORS[colorIdx];

      // Label bar with burned text
      mosaicWin.mainView.beginProcess();
      gi_burnLabel( mosaicWin.mainView.image, r.label, colX, SEP, tileW, LABEL_H, tc[0], tc[1], tc[2] );
      mosaicWin.mainView.endProcess();

      // Corrected tile — top row
      var corrY = SEP+LABEL_H+SEP;
      if (r.correctedId) prepareBlit(r.correctedId, false, false, colX, corrY);

      // Model tile — bottom row
      var modelY = SEP+LABEL_H+SEP + tileH+SEP;
      if (r.modelId)     prepareBlit(r.modelId, true, !!r.isAutoDBE, colX, modelY);

      col++;
   }

   mosaicWin.show();
   mosaicWin.zoomToFit();

   console.writeln("");
   console.writeln("  GradientInspector mosaic: " + mosaicId);
   console.writeln("  Top row = Corrected   |   Bottom row = Gradient model");
   console.writeln("  Columns left to right:");
   var c2=0;
   for (var i=0;i<results.length;i++) {
      var r=results[i];
      if (r.failed) { console.writeln("    "+r.label+" [FAILED]"); continue; }
      console.writeln("    Col "+(c2+1)+": "+r.label);
      c2++;
   }
   return mosaicId;
}

// =========================================================================
// Individual tool runners
// =========================================================================

// Run BN on a clone if it is a colour image
function gi_applyBN( view ) {
   if ( view.image.numberOfChannels < 3 ) return;
   var bn = new BackgroundNeutralization;
   bn.backgroundReferenceViewId = "";
   bn.backgroundLow    = 0.0;
   bn.backgroundHigh   = 0.12;
   bn.useROI           = false;
   bn.mode             = GI_BN_RESCALE;
   bn.targetBackground = 0.001;
   bn.executeOn( view );
}

function gi_runGC( srcView ) {
   var cloneId = srcView.id + "_GI_GC";
   var img = srcView.image;
   var cloneWin = new ImageWindow(img.width,img.height,img.numberOfChannels,img.bitsPerSample,img.isReal,img.isColor);
   cloneWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   cloneWin.mainView.image.assign(img);
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = cloneId;
   if (srcView.window.hasAstrometricSolution) cloneWin.copyAstrometricSolution(srcView.window);
   cloneWin.keywords = srcView.window.keywords;
   cloneWin.show();

   var wBefore = gi_getAllWindowIds(); // snapshot AFTER clone is shown
   var gc = new GradientCorrection;
   gc.automaticConvergence  = true;
   gc.generateGradientModel = true;
   gc.executeOn( cloneWin.mainView );

   var wAfter = gi_getAllWindowIds();
   var modelId = null;
   for (var i=0;i<wAfter.length;i++) {
      if (wBefore.indexOf(wAfter[i])===-1) { modelId=wAfter[i]; break; }
   }
   console.writeln("  GC model window: " + (modelId||"none found"));
   return { correctedId:cloneId, modelId:modelId };
}

function gi_runMGC( srcView ) {
   var cloneId = srcView.id + "_GI_MGC";
   var img = srcView.image;
   var cloneWin = new ImageWindow(img.width,img.height,img.numberOfChannels,img.bitsPerSample,img.isReal,img.isColor);
   cloneWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   cloneWin.mainView.image.assign(img);
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = cloneId;
   if (srcView.window.hasAstrometricSolution) cloneWin.copyAstrometricSolution(srcView.window);
   cloneWin.keywords = srcView.window.keywords;
   cloneWin.show();
   var wBefore = gi_getAllWindowIds(); // snapshot AFTER clone is shown

   var mgc = new MultiscaleGradientCorrection;
   mgc.referenceImageId  = "";
   mgc.showGradientModel = true;

   if ( giParams.mgcIsOSC ) {
      mgc.grayMARSFilter  = "L";
      mgc.redMARSFilter   = "R";
      mgc.greenMARSFilter = "G";
      mgc.blueMARSFilter  = "B";
   } else {
      mgc.grayMARSFilter  = "L";
      mgc.redMARSFilter   = "SII";
      mgc.greenMARSFilter = "Ha";
      mgc.blueMARSFilter  = "OIII";
   }

   if ( giParams.mgcMarsPaths && giParams.mgcMarsPaths.trim() !== "" ) {
      mgc.useMARSDatabase = true;
      var paths = giParams.mgcMarsPaths.split(";");
      var marsFiles = [];
      for (var i=0;i<paths.length;i++) { var p=paths[i].trim(); if(p!=="") marsFiles.push([true,p]); }
      if (marsFiles.length>0) mgc.marsDatabaseFiles = marsFiles;
   } else {
      mgc.useMARSDatabase = false;
      console.warningln("  MGC: No MARS database paths set. MGC may fail without MARS files.");
   }

   // MGC requires SPFC metadata — run it on the clone first
   try {
      var spfc = new SpectrophotometricFluxCalibration;
      spfc.narrowbandMode        = false;
      spfc.grayFilterName        = "Astronomik UV-IR Block L-2";
      spfc.grayFilterTrCurve     = "300,0,380,0,400,1,500,1,675,1,710,0,800,0";
      spfc.redFilterName         = "Sony Color Sensor R-UVIRcut";
      spfc.redFilterTrCurve      = "572,0.122,574,0.187,576,0.262,578,0.346,580,0.433,582,0.521,584,0.606,586,0.686,588,0.755,590,0.812,592,0.851,594,0.871,596,0.876,598,0.885,600,0.892,602,0.896,604,0.897,606,0.897,608,0.895,610,0.891,650,0.829,680,0.704,700,0.649";
      spfc.greenFilterName       = "Sony Color Sensor G-UVIRcut";
      spfc.greenFilterTrCurve    = "462,0.098,470,0.267,480,0.566,490,0.832,500,0.921,510,0.967,520,0.989,530,0.997,540,0.977,550,0.955,560,0.919,570,0.860,580,0.775,590,0.665,600,0.537,610,0.403,620,0.282,630,0.216,640,0.179,650,0.158,660,0.155,670,0.170,680,0.207,700,0.289";
      spfc.blueFilterName        = "Sony Color Sensor B-UVIRcut";
      spfc.blueFilterTrCurve     = "400,0.438,410,0.557,420,0.631,430,0.682,440,0.743,450,0.783,460,0.797,470,0.801,480,0.774,490,0.633,500,0.473,510,0.348,520,0.251,530,0.179,540,0.126,550,0.089,560,0.061,570,0.039,580,0.033,590,0.026,600,0.022,650,0.040,680,0.071,700,0.073";
      spfc.deviceQECurveName     = "Sony IMX411/455/461/533/571";
      spfc.deviceQECurve         = "402,0.7219,420,0.8214,440,0.8905,460,0.9134,480,0.8963,500,0.8964,520,0.8761,540,0.8432,560,0.8062,580,0.7663,600,0.7101,620,0.663,640,0.6154,660,0.5592,680,0.5163,700,0.4586,720,0.4142,740,0.3802,760,0.3462,780,0.3138,800,0.2808,820,0.2533,840,0.2382,860,0.1918,880,0.168,900,0.1494,920,0.1183,940,0.1058,960,0.0714,996,0.0507";
      spfc.generateGraphs        = false;
      spfc.generateStarMaps      = false;
      spfc.generateTextFiles     = false;
      spfc.executeOn( cloneWin.mainView );
      console.writeln( "  SPFC complete for MGC clone." );
   } catch(e) {
      console.warningln( "  SPFC skipped: " + (e.message||e.toString()) );
   }

   mgc.executeOn( cloneWin.mainView );

   // Find any new window — exclude clone
   var wAfter = gi_getAllWindowIds();
   var modelId = null;
   for (var i=0;i<wAfter.length;i++) {
      if (wBefore.indexOf(wAfter[i])===-1) { modelId=wAfter[i]; break; }
   }
   console.writeln("  MGC model window: " + (modelId||"none found"));
   return { correctedId:cloneId, modelId:modelId };
}

function gi_runDBE( srcView ) {
   // DBE requires sample points — use ABE in automatic mode instead
   var cloneId = srcView.id + "_GI_DBE";
   var img = srcView.image;
   var cloneWin = new ImageWindow(img.width,img.height,img.numberOfChannels,img.bitsPerSample,img.isReal,img.isColor);
   cloneWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   cloneWin.mainView.image.assign(img);
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = cloneId;
   if (srcView.window.hasAstrometricSolution) cloneWin.copyAstrometricSolution(srcView.window);
   cloneWin.keywords = srcView.window.keywords;
   cloneWin.show();

   var wBefore = gi_getAllWindowIds(); // snapshot AFTER clone is shown
   var abe = new AutomaticBackgroundExtractor;
   abe.tolerance         = 1.000;
   abe.deviation         = 0.800;
   abe.unbalance         = 1.800;
   abe.minBoxFraction    = 0.050;
   abe.maxBackground     = 1.0;
   abe.minBackground     = 0.0;
   abe.useBrightnessLimits = false;
   abe.polyDegree        = 4;
   abe.boxSize           = 5;
   abe.boxSeparation     = 5;
   abe.abeDownsample     = 2.0;
   abe.writeSampleBoxes  = false;
   abe.justTrySamples    = false;
   abe.targetCorrection  = AutomaticBackgroundExtractor.Correction_Subtract;
   abe.normalize         = false;
   abe.discardModel      = false;
   abe.replaceTarget     = true;
   abe.correctedImageId  = "";
   abe.correctedImageSampleFormat = AutomaticBackgroundExtractor.CorrectedFormat_SameAsTarget;
   abe.verboseCoefficients = false;
   abe.compareModel      = false;
   abe.compareFactor     = 10.0;
   abe.executeOn( cloneWin.mainView );

   var wAfterABE = gi_getAllWindowIds();
   var modelId = null;
   for (var i=0;i<wAfterABE.length;i++) {
      if (wBefore.indexOf(wAfterABE[i])===-1) { modelId=wAfterABE[i]; break; }
   }
   console.writeln("  ABE model window: " + (modelId||"none found"));
   return { correctedId:cloneId, modelId:modelId };
}

function gi_runDBEPerimeter( srcView ) {
   var cloneId = srcView.id + "_GI_DBEp";
   var img = srcView.image;
   var cloneWin = new ImageWindow(img.width,img.height,img.numberOfChannels,img.bitsPerSample,img.isReal,img.isColor);
   cloneWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   cloneWin.mainView.image.assign(img);
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = cloneId;
   if (srcView.window.hasAstrometricSolution) cloneWin.copyAstrometricSolution(srcView.window);
   cloneWin.keywords = srcView.window.keywords;
   cloneWin.show();
   gi_applyBN( cloneWin.mainView );

   var view = cloneWin.mainView;
   var img2 = view.image;
   var radius = Math.round( Math.max(img2.width, img2.height) / 100 );
   radius = Math.max(20, Math.min(80, radius));
   var boxesPerSide = Math.max(4, Math.round(Math.max(img2.width, img2.height) / 500));
   var insetX = Math.round(img2.width  * 0.02);
   var insetY = Math.round(img2.height * 0.02);
   var samples = [];

   // Compute global median for weight normalization
   img2.selectedChannel=0; var gMed0=img2.median(); img2.resetSelections();
   var gMed1=gMed0, gMed2=gMed0;
   if (img2.numberOfChannels >= 3) {
      img2.selectedChannel=1; gMed1=img2.median(); img2.resetSelections();
      img2.selectedChannel=2; gMed2=img2.median(); img2.resetSelections();
   }

   function addSample( cx, cy ) {
      cx = Math.max(radius, Math.min(img2.width  - radius - 1, cx));
      cy = Math.max(radius, Math.min(img2.height - radius - 1, cy));
      var rect = new Rect(cx-radius, cy-radius, cx+radius, cy+radius);
      img2.selectedChannel=0; var z0=img2.median(rect); img2.resetSelections();
      var z1=z0, z2=z0;
      if (img2.numberOfChannels >= 3) {
         img2.selectedChannel=1; z1=img2.median(rect); img2.resetSelections();
         img2.selectedChannel=2; z2=img2.median(rect); img2.resetSelections();
      }
      // Weight = how close this sample is to global median (background level)
      // Samples significantly brighter than median are on nebulosity -> low weight
      var w0 = Math.max(0, Math.min(1, 1 - Math.abs(z0-gMed0)/(gMed0*3)));
      var w1 = Math.max(0, Math.min(1, 1 - Math.abs(z1-gMed1)/(gMed1*3)));
      var w2 = Math.max(0, Math.min(1, 1 - Math.abs(z2-gMed2)/(gMed2*3)));
      samples.push([cx, cy, radius, 0, 6, 0, z0, w0, z1, w1, z2, w2]);
   }

   for (var i=0; i<boxesPerSide; i++) {
      var x = insetX + Math.round(i*(img2.width-2*insetX)/(boxesPerSide-1));
      addSample(x, insetY);
      addSample(x, img2.height-insetY);
   }
   for (var j=1; j<boxesPerSide-1; j++) {
      var y = insetY + Math.round(j*(img2.height-2*insetY)/(boxesPerSide-1));
      addSample(insetX, y);
      addSample(img2.width-insetX, y);
   }
   console.writeln("  DBE: "+samples.length+" samples, radius="+radius+"px");

   var dataArr = [];
   for (var d=0; d<samples.length; d++) {
      var s=samples[d];
      dataArr.push([s[0]/img2.width, s[1]/img2.height, s[6],s[7], s[8],s[9], s[10],s[11]]);
   }

   var wBefore = gi_getAllWindowIds();
   var dbe = new DynamicBackgroundExtraction;
   dbe.samples              = samples;
   dbe.data                 = dataArr;
   dbe.numberOfChannels     = img2.numberOfChannels;
   dbe.derivativeOrder      = 2;
   dbe.smoothing            = 0.25;
   dbe.ignoreWeights        = false;
   dbe.modelId              = "";
   dbe.modelWidth           = 0;
   dbe.modelHeight          = 0;
   dbe.downsample           = 2;
   dbe.targetCorrection     = DynamicBackgroundExtraction.Subtract;
   dbe.normalize            = false;
   dbe.discardModel         = false;
   dbe.replaceTarget        = true;
   dbe.correctedImageId     = "";
   dbe.imageWidth           = img2.width;
   dbe.imageHeight          = img2.height;
   dbe.symmetryCenterX      = 0.5;
   dbe.symmetryCenterY      = 0.5;
   dbe.tolerance            = 0.5;
   dbe.shadowsRelaxation    = 3.0;
   dbe.minSampleFraction    = 0.05;
   dbe.defaultSampleRadius  = radius;
   dbe.samplesPerRow        = radius * 2;
   dbe.minWeight            = 0.75;
   dbe.executeOn( view );

   var wAfter = gi_getAllWindowIds();
   var modelId = null;
   for (var i2=0; i2<wAfter.length; i2++) {
      if (wBefore.indexOf(wAfter[i2])===-1) { modelId=wAfter[i2]; break; }
   }
   console.writeln("  DBE model window: " + (modelId||"none found"));
   return { correctedId:cloneId, modelId:modelId };
}

function gi_runGraXpert( srcView ) {
   var cloneId = srcView.id + "_GI_GraX";
   var img = srcView.image;
   var cloneWin = new ImageWindow(img.width,img.height,img.numberOfChannels,img.bitsPerSample,img.isReal,img.isColor);
   cloneWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   cloneWin.mainView.image.assign(img);
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = cloneId;
   if (srcView.window.hasAstrometricSolution) cloneWin.copyAstrometricSolution(srcView.window);
   cloneWin.keywords = srcView.window.keywords;
   cloneWin.show();

   var wBefore = gi_getAllWindowIds(); // snapshot AFTER clone is shown
   var gx = new GraXpert;
   gx.backgroundExtraction = true;
   gx.smoothing            = 1.0;
   gx.correction           = "Subtraction";
   gx.createBackground     = true;
   gx.backgroundExtractionAIModel = "";
   gx.denoising            = false;
   gx.strength             = 1.0;
   gx.batchSize            = 4;
   gx.disableGPU           = false;
   gx.replaceImage         = true;
   gx.showLogs             = false;
   gx.appPath              = "";
   gx.executeOn( cloneWin.mainView );
   Console.show();

   var wAfter = gi_getAllWindowIds();
   var modelId = null;
   for (var i=0;i<wAfter.length;i++) {
      if (wBefore.indexOf(wAfter[i])===-1) { modelId=wAfter[i]; break; }
   }
   console.writeln("  GraXpert model window: " + (modelId||"none found"));
   return { correctedId:cloneId, modelId:modelId };
}

// =========================================================================
// Apply STF to model window
// =========================================================================
function gi_stretchModel( modelId ) {
   if (!modelId) return;
   var w = ImageWindow.windowById(modelId);
   if (!w||w.isNull) return;
   gi_applySTF( w.mainView );
}


// =========================================================================
// Help dialog
// =========================================================================
function gi_showHelp( parent ) {
   var dlg = new Dialog();
   dlg.windowTitle = "GradientInspector v1.0 - Help";
   dlg.userResizable = true;
   dlg.minWidth = 620;
   dlg.minHeight = 520;

   var helpText = new TextBox( dlg );
   helpText.readOnly = true;
   helpText.useRichText = true;
   helpText.text = "<html><body style='font-family:sans-serif; font-size:10pt;'>" +
      "<h2>GradientInspector v1.0</h2><p>Runs up to five gradient removal tools on a single source image and displays the results in a single comparison mosaic. Each tool gets its own column, corrected image on top and gradient model on the bottom, so you can visually compare how each algorithm handles the gradient in your image.</p><p>This is a diagnostic tool, not a processing pipeline. Once you decide which tool works best, use the Apply Winner dialog to apply it to the original in one click.</p><hr/><h3>Before You Start</h3><ul><li>Run on a <b>linear</b> (unstretched) image</li><li>Crop stacking artifacts from the image perimeter before running</li><li>A plate solve is only required if you use MultiscaleGradientCorrection (MSGC)</li></ul><hr/><h3>The Tools</h3><p><b>GradientCorrection (GC)</b> — PI\'s gradient correction tool. Fast, works on any image, no plate solve required. Generally the best first choice.</p><p><b>AutomaticBackgroundExtraction (ABE)</b> — Places sample boxes automatically across the entire image. Works well on sparse starfields but can struggle on images with heavy nebulosity.</p><p><b>GraXpert</b> — AI-based gradient removal. Particularly effective on images where the gradient is interleaved with nebulosity. Requires the GraXpert plugin.</p><p><b>DynamicBackgroundExtraction (DBE)</b> — Perimeter-only sample placement. Avoids the image center where nebulosity and subjects typically appear. Mirrors how most astrophotographers use DBE manually.</p><p><b>AutoDBE (Seti Astro)</b> — Because PixInsight scripts cannot directly call other third-party scripts, GradientInspector follows the same process as Seti Astro\'s AutoDBE. Automatically finds optimal sample locations via gradient descent, placing samples in the darkest background regions.</p><p><b>MultiscaleGradientCorrection (MSGC)</b> — Disabled by default. Requires a plate-solved image, SPFC metadata, and MARS database files. Results may vary or MSGC may fail depending on your filter selection and sky coverage in the MARS database for your imaging location.</p><hr/><h3>The Comparison Mosaic</h3><p>Each tool gets one column. Top row shows corrected images, bottom row shows the gradient model each tool removed. Colored label bars identify each tool. The gradient model row shows what each tool extracted, helping you see which tools fit the actual gradient vs picking up nebulosity or other structure.</p><hr/><h3>Apply Winner</h3><p>After the mosaic is generated, the Apply Winner dialog appears automatically. Select the tool you prefer and click <b>Apply to Original</b>. This re-runs that tool on your original source image.</p><p><b>Note:</b> Applying a winner modifies the original image. Save your original first if you want to preserve it.</p><hr/><h3>Tips</h3><ul><li>On sparse starfields, ABE and AutoDBE tend to perform well</li><li>On heavy nebulosity fields, GC, GraXpert, and perimeter DBE generally produce better results</li><li>Working windows are automatically closed after the mosaic is built</li><li>GraXpert is the slowest tool, adding 10-15 seconds on large images</li></ul><hr/><h3>Attribution</h3><p>AutoDBE functionality adapted from <b>AutoDBE v1.6</b> by Franklin Marek / Seti Astro (<i>www.setiastro.com</i>), used under Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0).</p><p>GradientInspector is a free, non-commercial script.</p>" +
      "</body></html>";

   var closeBtn = new PushButton( dlg );
   closeBtn.text = "Close";
   closeBtn.onClick = function() { dlg.done(0); };

   var btnSizer = new HorizontalSizer;
   btnSizer.addStretch();
   btnSizer.add( closeBtn );

   dlg.sizer = new VerticalSizer;
   dlg.sizer.margin = 12;
   dlg.sizer.spacing = 8;
   dlg.sizer.add( helpText, 100 );
   dlg.sizer.add( btnSizer );

   dlg.execute();
}

// =========================================================================
// Parameters
// =========================================================================
var giParams = {
   sourceId:    "",
   runGC:       true,
   runMGC:      false,
   runDBE:      false,
   runDBEp:     true,
   runGraXpert: true,
   runAutoDBE:  true,
   mgcIsOSC:    true,
   mgcMarsPaths: ""
};

// =========================================================================
// Dialog
// =========================================================================
var GradientInspectorDialog = class extends Dialog {
   constructor() {
   super();

   var self = this;
   this.windowTitle = SCRIPT_TITLE + " v" + SCRIPT_VERSION;
   this.minWidth = 500;

   // Header
   var headerLabel = new Label(this);
   headerLabel.text = SCRIPT_TITLE + " v" + SCRIPT_VERSION + "  |  Select a linear image";
   headerLabel.styleSheet = "background-color:#1a5c1a;color:#ffffff;font-weight:bold;padding:6px;font-size:11px;";
   headerLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   headerLabel.minHeight = 30;

   // Image selector
   var imgLabel = new Label(this);
   imgLabel.text = "Source image:";
   imgLabel.minWidth = 110;
   imgLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

   var imgCombo = new ComboBox(this);
   imgCombo.editEnabled = false;
   imgCombo.addItem("-- Select image --");
   var windows = ImageWindow.windows;
   var activeWin = ImageWindow.activeWindow;
   for (var i=0;i<windows.length;i++) {
      imgCombo.addItem(windows[i].mainView.id);
      if (!activeWin.isNull && windows[i].mainView.id===activeWin.mainView.id) {
         imgCombo.currentItem = i+1;
         giParams.sourceId = activeWin.mainView.id;
      }
   }
   imgCombo.onItemSelected = function(idx) {
      giParams.sourceId = idx>0 ? imgCombo.itemText(idx) : "";
   };

   var imgRow = new HorizontalSizer;
   imgRow.spacing = 6;
   imgRow.add(imgLabel);
   imgRow.add(imgCombo, 100);

   // Tool checkboxes
   var toolGroup = new GroupBox(this);
   toolGroup.title = "Tools to run";
   toolGroup.sizer = new VerticalSizer;
   toolGroup.sizer.margin = 8;
   toolGroup.sizer.spacing = 5;

   function makeToolCheck(label, tooltip, paramKey) {
      var cb = new CheckBox(self);
      cb.text    = label;
      cb.checked = giParams[paramKey];
      cb.toolTip = tooltip;
      cb.onCheck = function(v) { giParams[paramKey] = v; updateMGCWarning(); };
      return cb;
   }

   var gcCheck   = makeToolCheck("GradientCorrection (GC)",          "Fast, reliable, plate-solve not required.", "runGC");
   var mgcCheck  = makeToolCheck("MultiscaleGradientCorrection (MGC)","Requires plate solve and suitable sky coverage.", "runMGC");
   var dbeCheck  = makeToolCheck("AutomaticBackgroundExtraction (ABE)", "Auto-sample background extraction. Fast and reliable, no manual sample placement required.", "runDBE");
   var graxCheck = makeToolCheck("GraXpert",                          "AI-based gradient removal. External process — console will reopen automatically.", "runGraXpert");
   var dbeCheck2 = makeToolCheck("DynamicBackgroundExtraction (DBE)", "Perimeter-box DBE matching ProcessContainerPlus settings. Radius auto-scales with image size.", "runDBEp");
   var adbeCheck = makeToolCheck("AutoDBE (Seti Astro)",              "Gradient descent automatic DBE. Adapted from AutoDBE v1.6 by Franklin Marek (CC BY-NC 4.0).", "runAutoDBE");

   var mgcWarning = new Label(this);
   mgcWarning.text = "  ⚠  MGC requires a plate-solved image and sufficient sky coverage to produce a valid model.";
   mgcWarning.styleSheet = "color:#cc8800;font-style:italic;font-size:10px;";
   mgcWarning.visible = giParams.runMGC;

   function updateMGCWarning() { mgcWarning.visible = giParams.runMGC; }

   var mgcIsOSCCheck = new CheckBox(self);
   mgcIsOSCCheck.text    = "    OSC image (uncheck for mono narrowband)";
   mgcIsOSCCheck.checked = giParams.mgcIsOSC;
   mgcIsOSCCheck.visible = giParams.runMGC;
   mgcIsOSCCheck.onCheck = function(v) { giParams.mgcIsOSC = v; };

   var mgcMarsLabel = new Label(self);
   mgcMarsLabel.text = "    MARS paths (.xmars):";
   mgcMarsLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   mgcMarsLabel.visible = giParams.runMGC;

   var mgcMarsEdit = new Edit(self);
   mgcMarsEdit.text    = giParams.mgcMarsPaths;
   mgcMarsEdit.minWidth = 300;
   mgcMarsEdit.visible = giParams.runMGC;
   mgcMarsEdit.toolTip = "Semicolon-separated paths to .xmars MARS database files.";
   mgcMarsEdit.onEditCompleted = function() { giParams.mgcMarsPaths = this.text.trim(); };

   function updateMGCControls() {
      mgcWarning.visible    = giParams.runMGC;
      mgcIsOSCCheck.visible = giParams.runMGC;
      mgcMarsLabel.visible  = giParams.runMGC;
      mgcMarsEdit.visible   = giParams.runMGC;
   }

   mgcCheck.onCheck = function(v) { giParams.runMGC = v; updateMGCControls(); };

   toolGroup.sizer.add(gcCheck);
   toolGroup.sizer.add(mgcCheck);
   toolGroup.sizer.add(mgcWarning);
   toolGroup.sizer.add(mgcIsOSCCheck);
   toolGroup.sizer.add(mgcMarsLabel);
   toolGroup.sizer.add(mgcMarsEdit);
   toolGroup.sizer.add(dbeCheck);
   toolGroup.sizer.add(graxCheck);
   toolGroup.sizer.add(dbeCheck2);
   toolGroup.sizer.add(adbeCheck);

   // Info label
   var infoLabel = new Label(this);
   infoLabel.text = "Each tool runs on a fresh clone. Output: corrected image top, gradient model bottom.\n" +
                    "Model images are auto-stretched for visibility. Original is never modified.";
   infoLabel.styleSheet = "color:#666666;font-style:italic;font-size:10px;";
   infoLabel.wordWrapping = true;

   // Buttons
   var runButton = new PushButton(this);
   runButton.text = "Run Inspector";
   runButton.icon = self.scaledResource(":/icons/power.png");
   runButton.onClick = function() { self.ok(); };

   var closeButton = new PushButton(this);
   closeButton.text = "Close";
   closeButton.icon = self.scaledResource(":/icons/close.png");
   closeButton.onClick = function() { self.cancel(); };

   var helpBtn = new PushButton(this);
   helpBtn.text = "Help";
   helpBtn.icon = self.scaledResource( ":/icons/help.png" );
   helpBtn.toolTip = "Open the help documentation.";
   helpBtn.onClick = function() { gi_showHelp( self ); };

   var buttonRow = new HorizontalSizer;
   buttonRow.spacing = 8;
   buttonRow.add(runButton);
   buttonRow.addSpacing(4);
   buttonRow.add(helpBtn);
   buttonRow.addStretch();
   buttonRow.add(closeButton);

   // Footer
   var footerLabel = new Label(this);
   footerLabel.text = SCRIPT_TITLE + " v" + SCRIPT_VERSION + "  |  Copyright 2026 Brannon Quel  |  AutoDBE adapted from Franklin Marek (CC BY-NC 4.0)";
   footerLabel.styleSheet = "color:#888888;font-size:9px;font-style:italic;";
   footerLabel.textAlignment = TextAlignment.Center | TextAlignment.VertCenter;

   // Main sizer
   this.sizer = new VerticalSizer;
   this.sizer.margin  = 0;
   this.sizer.spacing = 8;
   this.sizer.add(headerLabel);
   this.sizer.addSpacing(4);
   this.sizer.add(imgRow);
   this.sizer.addSpacing(4);
   this.sizer.add(toolGroup);
   this.sizer.addSpacing(4);
   this.sizer.add(infoLabel);
   this.sizer.addSpacing(8);
   this.sizer.add(buttonRow);
   this.sizer.addSpacing(4);
   this.sizer.add(footerLabel);
   this.sizer.margin = 10;

   this.adjustToContents();
   }
};


// =========================================================================
// Main pipeline
// =========================================================================
function formatElapsed(ms) {
   var s=ms/1000;
   if(s<60) return s.toFixed(1)+"s";
   var m=Math.floor(s/60);
   return m+"m "+(s-m*60).toFixed(0)+"s";
}

function runGradientInspector() {
   if (!giParams.sourceId) {
      (new MessageBox("Please select a source image.", SCRIPT_TITLE, StdIcon.Error, StdButton.Ok)).execute();
      return;
   }

   var srcWin = ImageWindow.windowById(giParams.sourceId);
   if (!srcWin||srcWin.isNull) {
      (new MessageBox("Source image not found: " + giParams.sourceId, SCRIPT_TITLE, StdIcon.Error, StdButton.Ok)).execute();
      return;
   }

   var srcView = srcWin.mainView;
   var results = [];
   var pipelineStart = Date.now();

   console.writeln("");
   console.writeln("  ========================================");
   console.writeln("  " + SCRIPT_TITLE + " v" + SCRIPT_VERSION);
   console.writeln("  Source: " + giParams.sourceId);
   console.writeln("  ========================================");

   var tools = [
      { key:"runGC",       label:"GradientCorrection",          fn: gi_runGC },
      { key:"runMGC",      label:"MultiscaleGradientCorrection", fn: gi_runMGC },
      { key:"runDBE",      label:"AutomaticBackgroundExtraction", fn: gi_runDBE },
      { key:"runGraXpert", label:"GraXpert",                     fn: gi_runGraXpert },
      { key:"runDBEp",     label:"DynamicBackgroundExtraction", fn: function(v){ return gi_runDBEPerimeter(v); } },
      { key:"runAutoDBE",  label:"AutoDBE",  isAutoDBE:true,     fn: function(v){ return gi_runAutoDBE(v); } }
   ];

   var timingLog = {};

   for (var i=0;i<tools.length;i++) {
      var tool = tools[i];
      if (!giParams[tool.key]) continue;

      console.writeln("  Running: " + tool.label + "...");
      var t0 = Date.now();
      try {
         var res = tool.fn(srcView);
         var elapsed = formatElapsed(Date.now()-t0);
         timingLog[tool.label] = elapsed;
         console.writeln("  " + tool.label + ": " + elapsed);
         // STF stretch the model
         // model stretching handled in prepareBlit
         results.push({ label:tool.label, correctedId:res.correctedId, modelId:res.modelId, failed:false, failMsg:"", isAutoDBE:!!tool.isAutoDBE });
      } catch(e) {
         var elapsed = formatElapsed(Date.now()-t0);
         timingLog[tool.label] = "FAILED";
         console.warningln("  " + tool.label + " FAILED: " + e.message);
         results.push({ label:tool.label, correctedId:null, modelId:null, failed:true, failMsg:e.message });
      }
   }

   if (results.length===0) {
      (new MessageBox("No tools were selected.", SCRIPT_TITLE, StdIcon.Warning, StdButton.Ok)).execute();
      return;
   }

   // Build mosaic
   console.writeln("  Building comparison mosaic...");
   var mosaicId = gi_buildMosaic(results, giParams.sourceId);

   // Close all working windows — mosaic is the deliverable
   console.writeln("  Closing working windows...");
   for (var i=0;i<results.length;i++) {
      var r = results[i];
      if (r.correctedId) gi_closeWindowById(r.correctedId);
      if (r.modelId)     gi_closeWindowById(r.modelId);
   }
   // Also close any GI tile windows from previous approach
   var allWins = ImageWindow.windows;
   for (var i=0;i<allWins.length;i++) {
      var wid = allWins[i].mainView.id;
      if (wid.indexOf("GI_") === 0 && wid !== mosaicId)
         allWins[i].forceClose();
   }

   var totalElapsed = formatElapsed(Date.now()-pipelineStart);
   console.writeln("");
   console.writeln("  ========================================");
   console.writeln("  Complete: " + mosaicId);
   console.writeln("  ----------------------------------------");
   for (var i=0;i<tools.length;i++) {
      if (!giParams[tools[i].key]) continue;
      var t=timingLog[tools[i].label]||"skipped";
      console.writeln("  " + tools[i].label + ": " + t);
   }
   console.writeln("  ----------------------------------------");
   console.writeln("  Total: " + totalElapsed);
   console.writeln("  ========================================");

   // Apply Winner dialog
   var successfulResults = results.filter(function(r){ return !r.failed; });
   if (successfulResults.length > 0) {
      var applyDialog = new ApplyWinnerDialog(successfulResults, giParams.sourceId);
      applyDialog.execute();
   }
}

// =========================================================================
// Apply Winner Dialog
// =========================================================================
var ApplyWinnerDialog = class extends Dialog {
   constructor( results, sourceId ) {
      super();
      var self = this;
      this.windowTitle = "Apply Winner — GradientInspector";
      this.minWidth = 380;

      var titleLabel = new Label(this);
      titleLabel.text = "Select the best result to apply to the original image:";
      titleLabel.wordWrapping = true;

      this._selectedTool = null;
      this._results = results;
      this._sourceId = sourceId;

      var radioGroup = new GroupBox(this);
      radioGroup.title = "Tool results";
      radioGroup.sizer = new VerticalSizer;
      radioGroup.sizer.margin = 8;
      radioGroup.sizer.spacing = 5;

      var radios = [];
      for (var i=0;i<results.length;i++) {
         var rb = new RadioButton(this);
         rb.text = results[i].label;
         rb._toolLabel = results[i].label;
         if (i===0) { rb.checked = true; self._selectedTool = results[0].label; }
         rb.onCheck = (function(lbl){ return function(v){ if(v) self._selectedTool = lbl; }; })(results[i].label);
         radioGroup.sizer.add(rb);
         radios.push(rb);
      }

      var noteLabel = new Label(this);
      noteLabel.text = "This will re-run the selected tool on the original image with Replace Target enabled. The original will be modified.";
      noteLabel.styleSheet = "color:#cc8800;font-style:italic;font-size:10px;";
      noteLabel.wordWrapping = true;

      var applyButton = new PushButton(this);
      applyButton.text = "Apply to Original";
      applyButton.icon = self.scaledResource(":/icons/ok.png");
      applyButton.onClick = function() {
         if (!self._selectedTool) return;
         var srcWin = ImageWindow.windowById(self._sourceId);
         if (!srcWin||srcWin.isNull) {
            (new MessageBox("Source image no longer available.", "GradientInspector", StdIcon.Error, StdButton.Ok)).execute();
            return;
         }
         console.writeln("  Applying " + self._selectedTool + " to " + self._sourceId + "...");
         try {
            if (self._selectedTool === "GradientCorrection") {
               var gc = new GradientCorrection; gc.smoothness=0.5; gc.modelId=""; gc.discardModel=true;
               gc.executeOn(srcWin.mainView);
            } else if (self._selectedTool === "MultiscaleGradientCorrection") {
               var mgc = new MultiscaleGradientCorrection;
               mgc.referenceImageId=""; mgc.showGradientModel=false;
               if(giParams.mgcIsOSC){mgc.grayMARSFilter="L";mgc.redMARSFilter="R";mgc.greenMARSFilter="G";mgc.blueMARSFilter="B";}
               else{mgc.grayMARSFilter="L";mgc.redMARSFilter="SII";mgc.greenMARSFilter="Ha";mgc.blueMARSFilter="OIII";}
               if(giParams.mgcMarsPaths&&giParams.mgcMarsPaths.trim()!==""){
                  mgc.useMARSDatabase=true;
                  var paths=giParams.mgcMarsPaths.split(";"); var mf=[];
                  for(var pi=0;pi<paths.length;pi++){var p=paths[pi].trim();if(p!=="")mf.push([true,p]);}
                  if(mf.length>0)mgc.marsDatabaseFiles=mf;
               } else { mgc.useMARSDatabase=false; }
               mgc.executeOn(srcWin.mainView);
            } else if (self._selectedTool === "AutomaticBackgroundExtraction") {
               var abe = new AutomaticBackgroundExtractor;
               abe.tolerance=1.0;abe.deviation=0.8;abe.unbalance=1.8;abe.minBoxFraction=0.05;
               abe.maxBackground=1.0;abe.minBackground=0.0;abe.useBrightnessLimits=false;
               abe.polyDegree=4;abe.boxSize=5;abe.boxSeparation=5;abe.abeDownsample=2.0;
               abe.writeSampleBoxes=false;abe.justTrySamples=false;abe.targetCorrection=GI_ABE_SUBTRACT;
               abe.normalize=false;abe.discardModel=true;abe.replaceTarget=true;abe.correctedImageId="";
               abe.executeOn(srcWin.mainView);
            } else if (self._selectedTool === "DynamicBackgroundExtraction") {
               var dbeWin2 = ImageWindow.windowById(self._sourceId);
               gi_runDBEPerimeter(dbeWin2.mainView);
               self.ok();
               return;
            } else if (self._selectedTool === "GraXpert") {
               var gx2 = new GraXpert;
               gx2.backgroundExtraction=true; gx2.smoothing=1.0;
               gx2.correction="Subtraction"; gx2.createBackground=false;
               gx2.denoising=false; gx2.strength=1.0;
               gx2.replaceImage=true; gx2.showLogs=false;
               gx2.executeOn(srcWin.mainView); Console.show();
            } else if (self._selectedTool === "AutoDBE") {
               gi_runAutoDBE(srcWin.mainView);
            }
            console.writeln("  Done. " + self._sourceId + " updated.");
            self.ok();
         } catch(e) {
            (new MessageBox("Apply failed: " + e.message, "GradientInspector", StdIcon.Error, StdButton.Ok)).execute();
         }
      };

      var skipButton = new PushButton(this);
      skipButton.text = "Skip";
      skipButton.icon = self.scaledResource(":/icons/close.png");
      skipButton.onClick = function() { self.cancel(); };

      var btnRow = new HorizontalSizer;
      btnRow.spacing = 8;
      btnRow.add(applyButton);
      btnRow.addStretch();
      btnRow.add(skipButton);

      this.sizer = new VerticalSizer;
      this.sizer.margin = 10;
      this.sizer.spacing = 8;
      this.sizer.add(titleLabel);
      this.sizer.add(radioGroup);
      this.sizer.add(noteLabel);
      this.sizer.add(btnRow);
      this.adjustToContents();
   }
};

// =========================================================================
// Entry point
// =========================================================================
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
   Console.show();
   var dialog = new GradientInspectorDialog();
   if (dialog.execute()) runGradientInspector();
}

main();
