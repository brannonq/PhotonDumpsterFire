#engine v8

#feature-id    IterativeStretch : PhotonDumpsterFire > IterativeStretch
#feature-icon  IterativeStretch.svg
#feature-info  Progressive multi-pass adaptive stretch using HistogramTransformation.
#feature-info  SP moves rightward through the histogram across iterations.
#feature-info  Settings auto-saved between sessions. Preview before applying.

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

var SCRIPT_TITLE   = "IterativeStretch";
var SCRIPT_VERSION = "1.0";

// =========================================================================
// Settings persistence
// =========================================================================

var IS_SETTINGS_PATH = File.systemTempDirectory + "/IterativeStretch_settings.json";

function is_saveSettings( p ) {
   try {
      var f = new File;
      f.createForWriting( IS_SETTINGS_PATH );
      f.outTextLn( JSON.stringify({
         starsOnly:        p.starsOnly,
         starsScale:       p.starsScale,
         starsSat:         p.starsSat,
         starsBPSigma:     p.starsBPSigma,
         numPasses:        p.numPasses,
         targetBackground: p.targetBackground,
         spRange:          p.spRange,
         normalBPSigma:    p.normalBPSigma,
         finalBPTighten:   p.finalBPTighten,
         satBoost:         p.satBoost,
         satAmount:        p.satAmount
      }) );
      f.close();
   } catch(e) {}
}

function is_loadSettings( p ) {
   try {
      if ( !File.exists( IS_SETTINGS_PATH ) ) return;
      var f = new File;
      f.openForReading( IS_SETTINGS_PATH );
      var s = JSON.parse( f.read( DataType_ByteArray, f.size ).toString() );
      f.close();
      if ( s.starsOnly        !== undefined ) p.starsOnly        = s.starsOnly;
      if ( s.starsBPSigma     !== undefined ) p.starsBPSigma     = s.starsBPSigma;
      if ( s.starsScale       !== undefined ) p.starsScale       = s.starsScale;
      if ( s.starsSat         !== undefined ) p.starsSat         = s.starsSat;
      if ( s.numPasses        !== undefined ) p.numPasses        = s.numPasses;
      if ( s.targetBackground !== undefined ) p.targetBackground = s.targetBackground;
      if ( s.spRange          !== undefined ) p.spRange          = s.spRange;
      if ( s.normalBPSigma    !== undefined ) p.normalBPSigma    = s.normalBPSigma;
      if ( s.finalBPTighten   !== undefined ) p.finalBPTighten   = s.finalBPTighten;
      if ( s.satBoost         !== undefined ) p.satBoost         = s.satBoost;
      if ( s.satAmount        !== undefined ) p.satAmount        = s.satAmount;
   } catch(e) {}
}

// =========================================================================
// Statistics
// =========================================================================

function is_percentile( sorted, p ) {
   if ( sorted.length === 0 ) return 0;
   var idx = Math.max( 0, Math.min( sorted.length-1, Math.floor( p*(sorted.length-1) ) ) );
   return sorted[idx];
}

function is_channelStats( img, ch ) {
   var w=img.width, h=img.height;
   var step = Math.max( 1, Math.floor( Math.sqrt( (w*h)/120000 ) ) );
   var vals = [];
   for (var y=0;y<h;y+=step) for (var x=0;x<w;x+=step) {
      var v = img.sample(x,y,ch);
      if (isFinite(v)) vals.push( Math.max(0,Math.min(1,v)) );
   }
   vals.sort(function(a,b){return a-b;});
   var med = is_percentile(vals,0.50);
   var devs = [];
   for (var i=0;i<vals.length;i++) devs.push( Math.abs(vals[i]-med) );
   devs.sort(function(a,b){return a-b;});
   var mad = is_percentile(devs,0.50);
   return {
      p001: is_percentile(vals,0.001),
      p005: is_percentile(vals,0.005),
      p01:  is_percentile(vals,0.010),
      p50:  med,
      p90:  is_percentile(vals,0.900),
      p995: is_percentile(vals,0.995),
      sigma: 1.4826*mad
   };
}

function is_mergedStats( img ) {
   var nc = img.numberOfChannels;
   if ( nc < 3 ) return is_channelStats( img, 0 );
   var s0=is_channelStats(img,0), s1=is_channelStats(img,1), s2=is_channelStats(img,2);
   return {
      p001: Math.min(s0.p001,s1.p001,s2.p001),
      p005: Math.min(s0.p005,s1.p005,s2.p005),
      p01:  Math.min(s0.p01, s1.p01, s2.p01),
      p50:  (s0.p50+s1.p50+s2.p50)/3,
      p90:  (s0.p90+s1.p90+s2.p90)/3,
      p995: Math.max(s0.p995,s1.p995,s2.p995),
      sigma: Math.min(s0.sigma,s1.sigma,s2.sigma)
   };
}

function is_estimateBP( stats ) {
   var bp = stats.p005 - 0.5*stats.sigma;
   return Math.max( 0, Math.min( bp, stats.p005*0.95 ) );
}

// MAS-style BP from sigma multiplier: BP = median + C * sigma
// C is negative (e.g. -2.8), pulling BP below median toward noise floor.
// More negative = lower BP = less clipping. Less negative = higher BP = more clipping.
function is_bpFromSigma( img, sigmaC ) {
   var nc = img.numberOfChannels;
   // Use minimum BP across channels so no channel clips harder than intended
   var minBP = 1.0;
   for (var ch=0; ch < Math.min(nc,3); ch++) {
      img.selectedChannel = ch;
      var med = img.median();
      var mad = img.MAD();
      img.resetSelections();
      mad = (mad > 0) ? mad * 1.4826 : 1e-10;
      var bp = Math.max(0, med + sigmaC * mad);
      if (bp < minBP) minBP = bp;
   }
   return minBP;
}

// spRange: 0=p50 (conservative), 1=p90 (aggressive)
function is_estimateSP( stats, pass, totalPasses, spRange ) {
   // Pass 1: SP starts at histogram shoulder (blend of p05 and p50) rather than
   // near the noise floor -- matches manual GHS workflow of placing SP in the
   // middle of the histogram for the first big stretch.
   var shoulder = stats.p005 + 0.35 * (stats.p50 - stats.p005);
   var base = (pass === 0)
      ? shoulder
      : stats.p001 + stats.sigma * 0.5;
   var hi   = stats.p50 + spRange * (stats.p90 - stats.p50);
   var t    = pass / Math.max( 1, totalPasses-1 );
   return base + t*(hi-base);
}

function is_midtonesFromSP( sp, targetBg ) {
   if (sp <= 0) return 0.5;
   var denom = (2*targetBg-1)*sp - targetBg;
   if (Math.abs(denom) < 1e-10) return 0.5;
   var m = ((targetBg-1)*sp) / denom;
   return Math.max(0.001, Math.min(0.999, m));
}

// Per-pass stretch intensity table (b values, GHS-inspired)
// Mimics manual workflow: big aggressive first pass, tapering down each iteration.
// 3-pass: 8/3/1   5-pass: 8/5/2/1/0   other pass counts interpolated.
function is_passIntensity( pass, totalPasses ) {
   var tables = {
      1: [4],
      2: [8, 1],
      3: [8, 3, 1],
      4: [8, 4, 2, 0],
      5: [8, 5, 2, 1, 0]
   };
   var tbl = tables[totalPasses] || tables[3];
   var b = (pass < tbl.length) ? tbl[pass] : 0;
   return b;
}

// Midtones value incorporating stretch intensity b.
// b=0: standard HT midtones curve. b>0: pulls more aggressively, mimics GHS local intensity.
// Applies an additional bend: mid_eff = mid / (1 + b * (1 - mid))
// Higher b = more aggressive lift of faint signal, more highlight compression.
function is_applyIntensity( mid, b ) {
   if (b <= 0) return mid;
   var denom = 1.0 + b * (1.0 - mid);
   return Math.max(0.001, Math.min(0.999, mid / denom));
}

// Build stretch plan without applying it
function is_buildPlan( img, params ) {
   var nPasses  = params.numPasses;
   var firstTgt = Math.min( 0.55, params.targetBackground * 2.5 );
   var plan = [];
   var planImg = new Image( img.width, img.height, img.numberOfChannels,
      img.isColor ? ColorSpace.RGB : ColorSpace.Gray, 32, PixelSampleType.Float );
   planImg.assign( img );
   for (var p=0; p<nPasses; p++) {
      var stats = is_mergedStats( planImg );
      var bp    = is_bpFromSigma( planImg, params.normalBPSigma );
      var sp    = is_estimateSP( stats, p, nPasses, params.spRange );
      var t     = p / Math.max(1,nPasses-1);
      var tBg   = firstTgt - t*(firstTgt - params.targetBackground);
      var b      = is_passIntensity(p, nPasses);
      var range0 = 1.0-bp; if(range0<1e-10)range0=1.0;
      var spNorm0= Math.max(0,Math.min(1,(sp-bp)/range0));
      var midBase= is_midtonesFromSP(spNorm0,tBg);
      var mid    = is_applyIntensity(midBase, b);
      plan.push({ pass:p+1, bp:bp, sp:sp, targetBg:tBg, b:b,
         median:stats.p50, p90:stats.p90 });
      // Simulate the stretch on planImg
      var range = range0;
      var ht = new HistogramTransformation;
      var identity = [0,0.5,1.0,0.0,1.0];
      var row = [bp,mid,1.0,0.0,1.0];
      if ( img.numberOfChannels < 3 )
         ht.H = [identity,identity,identity,row,identity];
      else
         ht.H = [row,row,row,identity,identity];
      // Apply to planImg via temp window for simulation
      var pm = new PixelMath;
      if (img.numberOfChannels < 3) {
         pm.useSingleExpression=true;
         pm.expression = "mtf("+mid.toFixed(6)+",max(0,($T-"+bp.toFixed(6)+")/"+range.toFixed(6)+"))";
      } else {
         pm.useSingleExpression=true;
         pm.expression = "mtf("+mid.toFixed(6)+",max(0,($T-"+bp.toFixed(6)+")/"+range.toFixed(6)+"))";
      }
      pm.generateOutput=true; pm.rescale=false; pm.truncate=true;
      pm.createNewImage=false; pm.showNewImage=false;
      // Use a temp window for plan simulation
      var tmpWin = new ImageWindow(planImg.width,planImg.height,planImg.numberOfChannels,32,true,planImg.numberOfChannels>=3);
      tmpWin.mainView.beginProcess(UndoFlag.NoSwapFile);
      tmpWin.mainView.image.assign(planImg);
      tmpWin.mainView.endProcess();
      pm.executeOn(tmpWin.mainView);
      planImg.assign(tmpWin.mainView.image);
      tmpWin.forceClose();
   }
   planImg.free();
   return plan;
}

// Apply stretch for real
function is_applyStretch( view, params ) {
   var img      = view.image;
   var isColor  = img.numberOfChannels >= 3;
   var nPasses  = params.numPasses;
   var firstTgt = Math.min( 0.55, params.targetBackground * 2.5 );

   function getStats() { return is_mergedStats( view.image ); }

   console.writeln( "  Iterations: " + nPasses + "  Target bg: " + params.targetBackground.toFixed(2) + "  SP range: " + params.spRange.toFixed(2) );

   for (var pass=0; pass<nPasses; pass++) {
      var stats = getStats();
      var bp    = is_bpFromSigma( view.image, params.normalBPSigma );
      var sp    = is_estimateSP( stats, pass, nPasses, params.spRange );
      var t     = pass / Math.max(1,nPasses-1);
      var tBg   = firstTgt - t*(firstTgt - params.targetBackground);
      var b     = is_passIntensity(pass, nPasses);
      var range = 1.0-bp; if(range<1e-10)range=1.0;
      var spNorm= Math.max(0,Math.min(1,(sp-bp)/range));
      var mid   = is_applyIntensity(is_midtonesFromSP(spNorm,tBg), b);

      // Count shadow-clipped pixels before stretch
      var clipImg = view.image;
      var clipTotal = clipImg.width * clipImg.height;
      var clipStep  = Math.max(1, Math.floor(Math.sqrt(clipTotal / 80000)));
      var clipCount = 0;
      for (var cy=0;cy<clipImg.height;cy+=clipStep) for (var cx=0;cx<clipImg.width;cx+=clipStep)
         if (clipImg.sample(cx,cy,0) <= bp) clipCount++;
      var clipPct = (clipCount / (clipTotal / (clipStep*clipStep)) * 100).toFixed(2);

      console.writeln( "  Iter " + (pass+1) + "/" + nPasses +
         "  BP=" + bp.toFixed(5) +
         "  SP=" + sp.toFixed(5) +
         "  mid=" + mid.toFixed(4) +
         "  b=" + b.toFixed(0) +
         "  tBg=" + tBg.toFixed(2) +
         "  clip=" + clipPct + "%" );

      var ht = new HistogramTransformation;
      var identity = [0,0.5,1.0,0.0,1.0];
      var row = [bp,mid,1.0,0.0,1.0];
      if (!isColor) ht.H=[identity,identity,identity,row,identity];
      else          ht.H=[row,row,row,identity,identity];
      ht.executeOn(view,false);
   }

   if (params.finalBPTighten) {
      var fStats = getStats();
      var fBP = is_estimateBP(fStats);
      if (fBP > 0.001) {
         console.writeln( "  Final BP tighten: " + fBP.toFixed(5) );
         var ht2 = new HistogramTransformation;
         var identity2=[0,0.5,1.0,0.0,1.0];
         var row2=[fBP,0.5,1.0,0.0,1.0];
         if (!isColor) ht2.H=[identity2,identity2,identity2,row2,identity2];
         else          ht2.H=[row2,row2,row2,identity2,identity2];
         ht2.executeOn(view,false);
      }
   }

   if (isColor && params.satBoost) {
      console.writeln( "  Saturation boost: " + params.satAmount.toFixed(2) );
      var cc = new CurvesTransformation;
      // Safe saturation curve: control point at x=0.5, y lifted by satAmount fraction.
      // Clamped to [0,0.99] so PI never sees an out-of-range identity collapse.
      var satX = 0.5;
      var satY = Math.min(0.99, 0.5 + (params.satAmount - 0.05) * 0.35);
      cc.S = [[0,0],[satX, satY],[1,1]];
      cc.executeOn(view,false);
   }
}

// =========================================================================
// Preview ScrollBox (NPB style)
// =========================================================================

var ISPreviewScrollBox = class extends ScrollBox {
   constructor( parent ) {
      super( parent );
      this.bitmap = null; this.zoomFactor=1.0;
      this.minZoom=0.05; this.maxZoom=16.0;
      this.dragging=false; this.onZoomChanged=null;
      this.dragOrigin=new Point(0,0); this.dragScrollStart=new Point(0,0);
      this.autoScroll=true; this.tracking=true;
      let self=this;
      this.onHorizontalScrollPosUpdated=function(){this.viewport.update();};
      this.onVerticalScrollPosUpdated=function(){this.viewport.update();};
      this.viewport.onResize=function(){self._upd();};
      this.viewport.onMousePress=function(x,y,btn){
         if((btn&1)===0)return; self.dragging=true;
         self.dragOrigin=new Point(x,y);
         self.dragScrollStart=new Point(self.horizontalScrollPosition,self.verticalScrollPosition);
      };
      this.viewport.onMouseRelease=function(){self.dragging=false;};
      this.viewport.onMouseMove=function(x,y){
         if(self.dragging){
            self.horizontalScrollPosition=self.dragScrollStart.x+(self.dragOrigin.x-x);
            self.verticalScrollPosition=self.dragScrollStart.y+(self.dragOrigin.y-y);
         }
      };
      this.viewport.onMouseWheel=function(x,y,delta){
         var oldZ=self.zoomFactor;
         var newZ=delta>0?Math.min(oldZ*1.25,self.maxZoom):Math.max(oldZ*0.8,self.minZoom);
         if(newZ===oldZ)return; self._zoomAt(newZ,x,y);
         if(self.onZoomChanged)self.onZoomChanged(self.zoomFactor);
      };
      this.viewport.onPaint=function(x0,y0,x1,y1){
         var g=new Graphics(this);
         g.fillRect(x0,y0,x1,y1,new Brush(0xFF080808));
         if(self.bitmap){
            var bw=Math.round(self.bitmap.width*self.zoomFactor);
            var bh=Math.round(self.bitmap.height*self.zoomFactor);
            var dx=self.maxHorizontalScrollPosition>0?-self.horizontalScrollPosition:Math.floor((this.width-bw)/2);
            var dy=self.maxVerticalScrollPosition>0?-self.verticalScrollPosition:Math.floor((this.height-bh)/2);
            g.drawScaledBitmap(new Rect(dx,dy,dx+bw,dy+bh),self.bitmap);
            g.pen=new Pen(0xff444444,0);
            g.drawRect(dx-1,dy-1,dx+bw,dy+bh);
         } else {
            g.pen=new Pen(0xFF334466);
            g.font=new Font("Helvetica",12);
            var msg="Click Preview to render";
            var tw=g.font.width(msg);
            g.drawText(Math.round((this.width-tw)/2),Math.round(this.height/2)+6,msg);
         }
         g.end();
      };
   }
   _upd(){
      if(!this.bitmap){this.setHorizontalScrollRange(0,0);this.setVerticalScrollRange(0,0);}
      else{
         var bw=Math.round(this.bitmap.width*this.zoomFactor);
         var bh=Math.round(this.bitmap.height*this.zoomFactor);
         this.setHorizontalScrollRange(0,Math.max(0,bw-this.viewport.width));
         this.setVerticalScrollRange(0,Math.max(0,bh-this.viewport.height));
      }
      this.viewport.update();
   }
   _zoomAt(newZ,vx,vy){
      var ratio=newZ/this.zoomFactor; this.zoomFactor=newZ; this._upd();
      this.horizontalScrollPosition=Math.max(0,(this.horizontalScrollPosition+vx)*ratio-vx);
      this.verticalScrollPosition=Math.max(0,(this.verticalScrollPosition+vy)*ratio-vy);
   }
   setBitmap(bmp){if(this.bitmap)this.bitmap.clear();this.bitmap=(bmp&&bmp.width>0)?bmp:null;this._upd();}
   zoomFit(){
      if(!this.bitmap)return;
      var z=Math.max(this.minZoom,Math.min(this.maxZoom,Math.min(this.viewport.width/this.bitmap.width,this.viewport.height/this.bitmap.height)));
      this.zoomFactor=z;this.horizontalScrollPosition=0;this.verticalScrollPosition=0;this._upd();
      if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor);
   }
   zoomIn(){var n=Math.min(this.zoomFactor*1.25,this.maxZoom);this._zoomAt(n,Math.floor(this.viewport.width/2),Math.floor(this.viewport.height/2));if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor);}
   zoomOut(){var n=Math.max(this.zoomFactor*0.8,this.minZoom);this._zoomAt(n,Math.floor(this.viewport.width/2),Math.floor(this.viewport.height/2));if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor);}
   zoom1to1(){this.zoomFactor=1.0;this.horizontalScrollPosition=0;this.verticalScrollPosition=0;this._upd();if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor);}
};

// =========================================================================
// Parameters
// =========================================================================

var isParams = {
   sourceId:         "",
   starsOnly:        false,
   starsScale:       4.0,
   starsSat:         0.30,
   starsBPSigma:     -2.8,
   numPasses:        3,
   targetBackground: 0.20,
   spRange:          0.5,
   normalBPSigma:    -2.8,
   finalBPTighten:   true,
   satBoost:         false,
   satAmount:        0.30
};
is_loadSettings( isParams );

// =========================================================================
// Help
// =========================================================================

function is_showHelp() {
   var dlg = new Dialog();
   dlg.windowTitle = SCRIPT_TITLE + " v" + SCRIPT_VERSION + " - Help";
   dlg.userResizable=true; dlg.minWidth=580; dlg.minHeight=480;
   var helpText = new TextBox(dlg);
   helpText.readOnly=true; helpText.useRichText=true;
   helpText.text = "<html><body style='font-family:sans-serif;font-size:10pt;'>" +
      "<h2>IterativeStretch v1.0</h2>" +
      "<p>Progressive multi-pass adaptive stretch. Each iteration measures fresh statistics, " +
      "sets BP just above the data floor, and moves SP rightward through the histogram. " +
      "Applies to a <b>copy</b> of the source image.</p>" +
      "<hr/><h3>Parameters</h3>" +
      "<p><b>Iterations (1-5):</b> Number of stretch passes. 3 is a good starting point. " +
      "More iterations = more gradual, smoother result.</p>" +
      "<p><b>Target background (0.05-0.40):</b> Controls final brightness. Lower = darker background. " +
      "First iteration targets up to 2.5x this value to pull up faint signal.</p>" +
      "<p><b>SP range (0-1):</b> Controls how far SP moves across iterations. " +
      "0 = conservative (SP stays near median), 1 = aggressive (SP reaches p90). " +
      "Higher values pull more midtone detail on later iterations.</p>" +
      "<p><b>Shadows clipping (-5.0 to 0.0):</b> Sets black point as median + (C * sigma). " +
      "Default -2.8 matches MAS. More negative = lower BP. Less negative = darker background.</p>" +
      "<p><b>Final BP tighten:</b> Clips BP after all passes to improve contrast.</p>" +
      "<p><b>Saturation boost (OSC only):</b> Mild saturation curve after luminance stretch.</p>" +
      "<hr/><h3>Notes</h3>" +
      "<ul><li>Image must be linear (unstretched)</li>" +
      "<li>Run gradient correction and BN first</li>" +
      "<li>Settings are saved automatically between sessions</li>" +
      "<li>Result is a copy named <i>sourceid_IS</i></li></ul>" +
      "</body></html>";
   var closeBtn=new PushButton(dlg); closeBtn.text="Close";
   closeBtn.onClick=function(){dlg.done(0);};
   var bs=new HorizontalSizer; bs.addStretch(); bs.add(closeBtn);
   dlg.sizer=new VerticalSizer; dlg.sizer.margin=12; dlg.sizer.spacing=8;
   dlg.sizer.add(helpText,100); dlg.sizer.add(bs);
   dlg.execute();
}

// =========================================================================
// Stars Only iterative rational stretch
// BP via MAS-style median + C*sigma. Formula: (k*$T)/((k-1)*$T+1), k=3^passAmount.
// Applied across numPasses for progressive compression.
// =========================================================================

function is_applyStarsStretch( view, scale, numPasses, satAmount, doSat, bpSigmaC ) {
   var img     = view.image;
   var isColor = img.numberOfChannels >= 3;

   // --- BP: MAS-style median + C*sigma ---
   var bp = is_bpFromSigma(img, bpSigmaC);

   // Count clipped pixels at this BP for console reporting
   var clipStep = Math.max(1, Math.floor(Math.sqrt((img.width*img.height)/80000)));
   var clipCount = 0, clipSamples = 0;
   for (var cy=0;cy<img.height;cy+=clipStep) for (var cx=0;cx<img.width;cx+=clipStep) {
      if (img.sample(cx,cy,0) <= bp) clipCount++;
      clipSamples++;
   }
   var clipPct = (clipCount / Math.max(1,clipSamples) * 100).toFixed(2);

   // --- BP clip via HT ---
   if (bp > 0) {
      var htBP = new HistogramTransformation;
      var idBP = [0,0.5,1.0,0.0,1.0];
      var rowBP = [bp,0.5,1.0,0.0,1.0];
      if (!isColor) htBP.H=[idBP,idBP,idBP,rowBP,idBP]; else htBP.H=[rowBP,rowBP,rowBP,idBP,idBP];
      htBP.executeOn(view,false);
   }

   // --- Iterative rational stretch ---
   // Amount split evenly across passes. Each pass: (k*$T)/((k-1)*$T+1), k=3^passAmount
   var nPasses    = Math.max(1, numPasses);
   var passAmount = Math.max(1.0, scale / nPasses);
   for (var pass=0; pass<nPasses; pass++) {
      var k    = Math.pow(3, passAmount);
      var expr = "(" + k.toFixed(6) + "*$T)/((" + (k-1).toFixed(6) + ")*$T+1)";
      var pm = new PixelMath;
      pm.useSingleExpression = true;
      pm.expression  = expr;
      pm.expression1 = ""; pm.expression2 = ""; pm.expression3 = "";
      pm.generateOutput = true; pm.rescale = false;
      pm.truncate = true; pm.truncateLower = 0; pm.truncateUpper = 1;
      pm.createNewImage = false; pm.showNewImage = false;
      pm.executeOn(view, false);
      // BP and clip% computed before the loop; show on first pass only
      var iterLine = "  Stars iter "+(pass+1)+"/"+nPasses+
         "  passAmt="+passAmount.toFixed(2)+"  k="+k.toFixed(1);
      if (pass === 0) iterLine += "  BP="+bp.toFixed(5)+"  clipped="+clipPct+"%";
      console.writeln(iterLine);
   }

   // --- Final BP tighten ---
   var fStats = is_mergedStats(view.image);
   var fBP    = is_estimateBP(fStats);
   if (fBP > 0.0005) {
      var htF = new HistogramTransformation;
      var idF = [0,0.5,1.0,0.0,1.0]; var rowF = [fBP,0.5,1.0,0.0,1.0];
      if (!isColor) htF.H=[idF,idF,idF,rowF,idF]; else htF.H=[rowF,rowF,rowF,idF,idF];
      htF.executeOn(view,false);
      console.writeln("  Stars final BP tighten: "+fBP.toFixed(5));
   }

   // --- Saturation boost ---
   if (isColor && doSat) {
      var ccS = new CurvesTransformation;
      var satSX = 0.5;
      var satSY = Math.min(0.99, 0.5 + (satAmount - 0.05) * 0.35);
      ccS.S = [[0,0],[satSX, satSY],[1,1]];
      ccS.executeOn(view,false);
   }

   console.writeln("  Stars complete: amount="+scale.toFixed(2)+
      "  passes="+nPasses+
      (doSat?"  sat="+satAmount.toFixed(2):""));
}

// =========================================================================
// Main dialog
// =========================================================================

var ISDialog = class extends Dialog {
   constructor() {
      super();
      var self = this;
      this.windowTitle = SCRIPT_TITLE + " v" + SCRIPT_VERSION;
      this.userResizable = true;
      this.minWidth = 900;
      this.minHeight = 620;

      // ---- LEFT PANEL: controls ----
      var headerLabel = new Label(this);
      headerLabel.text = SCRIPT_TITLE + " v" + SCRIPT_VERSION + "  |  Progressive adaptive stretch";
      headerLabel.styleSheet = "background:#1a1a4a;color:#88aaff;font-weight:bold;font-size:11px;padding:6px;";
      headerLabel.textAlignment = TextAlignment.Center | TextAlignment.VertCenter;
      headerLabel.setFixedHeight(32);

      // Source image
      // Stars Only mode -- GroupBox wrapper
      var starsOnlyCheck = new CheckBox(this);
      starsOnlyCheck.text = "Stars Only image (iterative rational stretch)";
      starsOnlyCheck.checked = isParams.starsOnly;
      starsOnlyCheck.toolTip = "Check when working with a stars-only image extracted by StarXTerminator.\n" +
         "Switches to iterative rational stretch optimised for star core compression.\n" +
         "Uncheck for normal nebulosity/broadband images.";
      starsOnlyCheck.styleSheet = "font-weight:bold;color:#111111;font-size:11px;";

      var modeGroup = new GroupBox(this);
      modeGroup.title = "Mode";
      modeGroup.sizer = new VerticalSizer;
      modeGroup.sizer.margin = 8;
      modeGroup.sizer.spacing = 4;
      modeGroup.sizer.add(starsOnlyCheck);

      // Stars Only sliders
      var starsScaleCtrl = new NumericControl(this);
      starsScaleCtrl.label.text    = "Stretch amount:";
      starsScaleCtrl.label.minWidth = 120;
      starsScaleCtrl.setRange(1.0, 8.0);
      starsScaleCtrl.slider.setRange(0, 700);
      starsScaleCtrl.setPrecision(2);
      starsScaleCtrl.setValue(isParams.starsScale);
      starsScaleCtrl.toolTip = "Total rational stretch amount split evenly across iterations.\n" +
         "Low (1-3) = gentle lift, preserves star sizes.\n" +
         "High (5-8) = strong compression, smaller bright cores.\n" +
         "Default: 4.0.";
      starsScaleCtrl.onValueUpdated = function(v) { isParams.starsScale = v; };

      var starsSatCtrl = new NumericControl(this);
      starsSatCtrl.label.text    = "Saturation:";
      starsSatCtrl.label.minWidth = 120;
      starsSatCtrl.setRange(0.05, 2.00);
      starsSatCtrl.slider.setRange(0, 200);
      starsSatCtrl.setPrecision(2);
      starsSatCtrl.setValue(isParams.starsSat);
      starsSatCtrl.toolTip = "Saturation boost after stars stretch.\n" +
         "Star colors often wash out during compression — this recovers them.\n" +
         "Enable High saturation mode in Options for range up to 2.00. Default: 0.30.";
      starsSatCtrl.onValueUpdated = function(v) { isParams.starsSat = v; };

      var starsBPSigmaCtrl = new NumericControl(this);
      starsBPSigmaCtrl.label.text    = "Shadows clipping:";
      starsBPSigmaCtrl.label.minWidth = 120;
      starsBPSigmaCtrl.setRange(-5.0, 0.0);
      starsBPSigmaCtrl.slider.setRange(0, 500);
      starsBPSigmaCtrl.setPrecision(2);
      starsBPSigmaCtrl.setValue(isParams.starsBPSigma);
      starsBPSigmaCtrl.toolTip = "Black point = median + (this value * sigma).\n" +
         "More negative = lower BP, less clipping, lifts faint stars.\n" +
         "Less negative = higher BP, more clipping, darker background.\n" +
         "Watch clipped% in console output. Default: -2.8 (matches MAS).";
      starsBPSigmaCtrl.onValueUpdated = function(v) { isParams.starsBPSigma = v; };

      var imgLabel = new Label(this);
      imgLabel.text = "Source image:";
      imgLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      imgLabel.setFixedWidth(120);

      var imgCombo = new ComboBox(this);
      var wins = ImageWindow.windows;
      var activeId = (ImageWindow.activeWindow && !ImageWindow.activeWindow.isNull)
         ? ImageWindow.activeWindow.mainView.id : "";
      var activeIdx = 0;
      for (var i=0;i<wins.length;i++) {
         imgCombo.addItem(wins[i].mainView.id);
         if (wins[i].mainView.id === activeId) activeIdx = i;
      }
      imgCombo.currentItem = activeIdx;
      isParams.sourceId = (activeIdx < wins.length) ? wins[activeIdx].mainView.id : "";

      var modeLabel = new Label(this);
      modeLabel.styleSheet = "color:#887744;font-size:10px;font-style:italic;";

      function updateMode() {
         var w = ImageWindow.windowById(isParams.sourceId);
         if (!w||w.isNull) { modeLabel.text=""; return; }
         modeLabel.text = "Detected: " + (w.mainView.image.numberOfChannels>=3?"Color/OSC":"Mono");
      }
      imgCombo.onItemSelected = function(idx) {
         isParams.sourceId = imgCombo.itemText(idx);
         updateMode();
      };

      function updateModeVisibility() {
         var isStars = isParams.starsOnly;
         // Stars Only controls
         starsScaleCtrl.visible      = isStars;
         starsSatCtrl.visible        = isStars;
         starsBPSigmaCtrl.visible    = isStars;
         // Normal mode controls
         normalBPSigmaCtrl.visible   = !isStars;
         targetBgCtrl.visible       = !isStars;
         spRangeCtrl.visible        = !isStars;
         optGroup.visible           = !isStars;
         // Iterations visible in both modes
         passLabel.visible          = true;
         passSpinner.visible        = true;
      }
      starsOnlyCheck.onCheck = function(v) {
         isParams.starsOnly = v;
         updateModeVisibility();
      };
      updateMode();

      var imgRow = new HorizontalSizer;
      imgRow.spacing=8; imgRow.add(imgLabel); imgRow.add(imgCombo,100);

      // Iterations
      var passLabel = new Label(this);
      passLabel.text = "Iterations:";
      passLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      passLabel.setFixedWidth(120);

      var passSpinner = new SpinBox(this);
      passSpinner.setRange(1,5); passSpinner.value = isParams.numPasses;
      passSpinner.toolTip = "Number of stretch iterations. 3 recommended.\nMore = gradual, smoother. Fewer = faster, more aggressive.";
      passSpinner.onValueUpdated = function(v) { isParams.numPasses=v; };

      var passRow = new HorizontalSizer;
      passRow.spacing=8; passRow.add(passLabel); passRow.add(passSpinner); passRow.addStretch();

      // Target background
      var targetBgCtrl = new NumericControl(this);
      targetBgCtrl.label.text="Target background:"; targetBgCtrl.label.minWidth=120;
      targetBgCtrl.setRange(0.05,0.40); targetBgCtrl.slider.setRange(0,100);
      targetBgCtrl.setPrecision(2); targetBgCtrl.setValue(isParams.targetBackground);
      targetBgCtrl.toolTip="Final brightness target. Lower = darker background.\nDefault: 0.20. Try 0.12-0.18 for darker result.";
      targetBgCtrl.onValueUpdated=function(v){isParams.targetBackground=v;};

      // SP range
      var spRangeCtrl = new NumericControl(this);
      spRangeCtrl.label.text="SP range:"; spRangeCtrl.label.minWidth=120;
      spRangeCtrl.setRange(0.0,1.0); spRangeCtrl.slider.setRange(0,100);
      spRangeCtrl.setPrecision(2); spRangeCtrl.setValue(isParams.spRange);
      spRangeCtrl.toolTip="How far SP moves across iterations.\n0=conservative (stays near median), 1=aggressive (reaches p90).\nHigher = more midtone detail on later iterations. Default: 0.5.";
      spRangeCtrl.onValueUpdated=function(v){isParams.spRange=v;};

      // Normal mode BP sigma (MAS-style shadows clipping)
      var normalBPSigmaCtrl = new NumericControl(this);
      normalBPSigmaCtrl.label.text    = "Shadows clipping:";
      normalBPSigmaCtrl.label.minWidth = 120;
      normalBPSigmaCtrl.setRange(-5.0, 0.0);
      normalBPSigmaCtrl.slider.setRange(0, 500);
      normalBPSigmaCtrl.setPrecision(2);
      normalBPSigmaCtrl.setValue(isParams.normalBPSigma);
      normalBPSigmaCtrl.toolTip = "Black point = median + (this value * sigma).\n" +
         "More negative = lower BP, preserves faint signal.\n" +
         "Less negative = higher BP, clips more aggressively toward black.\n" +
         "Watch BP values in the stretch plan. Default: -2.8 (matches MAS).";
      normalBPSigmaCtrl.onValueUpdated = function(v) { isParams.normalBPSigma = v; };

      // Options
      var optGroup = new GroupBox(this);
      optGroup.title="Options";
      optGroup.sizer=new VerticalSizer; optGroup.sizer.margin=8; optGroup.sizer.spacing=6;

      var bpTightenCheck = new CheckBox(this);
      bpTightenCheck.text="Final BP tighten (improve contrast after stretch)";
      bpTightenCheck.checked=isParams.finalBPTighten;
      bpTightenCheck.toolTip="One final BP clip after all iterations to tighten background contrast.";
      bpTightenCheck.onCheck=function(v){isParams.finalBPTighten=v;};

      var satCheck = new CheckBox(this);
      satCheck.text="Saturation boost after stretch (OSC only)";
      satCheck.checked=isParams.satBoost;
      satCheck.toolTip="Mild saturation curve after luminance stretching. OSC/color images only.";
      satCheck.onCheck=function(v){isParams.satBoost=v;};

      var satCtrl = new NumericControl(this);
      satCtrl.label.text="  Saturation amount:"; satCtrl.label.minWidth=140;
      satCtrl.setRange(0.05, 2.00);
      satCtrl.slider.setRange(0,200);
      satCtrl.setPrecision(2); satCtrl.setValue(isParams.satAmount);
      satCtrl.toolTip="Saturation curve intensity. 0.20-0.40 typical. Up to 2.00 for strong colour boost.";
      satCtrl.onValueUpdated=function(v){isParams.satAmount=v;};

      optGroup.sizer.add(bpTightenCheck);
      optGroup.sizer.add(satCheck);
      optGroup.sizer.add(satCtrl);

      // Stats panel
      var statsBox = new TextBox(this);
      statsBox.readOnly=true;
      statsBox.setMinSize(240,120);
      statsBox.styleSheet="font-family:monospace;font-size:15px;background:#0a0a1a;color:#88aacc;";
      statsBox.text="Click Preview to see stretch plan.";

      // Buttons
      var previewBtn = new PushButton(this);
      previewBtn.text="Preview / Refresh";
      previewBtn.icon=self.scaledResource(":/icons/find.png");
      previewBtn.toolTip="Compute stretch plan and show preview. Does not modify original.";

      var applyBtn = new PushButton(this);
      applyBtn.text="Apply";
      applyBtn.icon=self.scaledResource(":/icons/power.png");
      applyBtn.toolTip="Apply stretch to a copy of the source image.";

      var helpBtn = new PushButton(this);
      helpBtn.text="Help";
      helpBtn.icon=self.scaledResource(":/icons/help.png");
      helpBtn.onClick=function(){is_showHelp();};

      var closeBtn = new PushButton(this);
      closeBtn.text="Close";
      closeBtn.icon=self.scaledResource(":/icons/close.png");
      closeBtn.onClick=function(){self.cancel();};

      var btnRow = new HorizontalSizer;
      btnRow.spacing=6;
      btnRow.add(previewBtn); btnRow.add(applyBtn);
      btnRow.addSpacing(4); btnRow.add(helpBtn);
      btnRow.addStretch(); btnRow.add(closeBtn);

      var footerLabel = new Label(this);
      footerLabel.text=SCRIPT_TITLE+" v"+SCRIPT_VERSION+"  |  Copyright 2026 Brannon Quel  |  Settings auto-saved";
      footerLabel.styleSheet="color:#888888;font-size:9px;font-style:italic;";
      footerLabel.textAlignment=TextAlignment.Center|TextAlignment.VertCenter;

      // ---- RIGHT PANEL: preview ----
      var previewBox = new ISPreviewScrollBox(this);
      previewBox.setMinSize(580, 540);

      var zoomLabel = new Label(this);
      zoomLabel.text="Zoom: fit";
      zoomLabel.styleSheet="color:#667799;min-width:75px;";
      zoomLabel.textAlignment=TextAlignment.Left|TextAlignment.VertCenter;

      previewBox.onZoomChanged=function(z){
         zoomLabel.text="Zoom: "+(z*100).toFixed(0)+"%";
      };

      var zoomInBtn  = new PushButton(this); zoomInBtn.text="  +  ";
      var zoomOutBtn = new PushButton(this); zoomOutBtn.text="  −  ";
      var zoomFitBtn = new PushButton(this); zoomFitBtn.text="Fit";
      var zoom100Btn = new PushButton(this); zoom100Btn.text="100%";
      zoomInBtn.onClick  = function(){previewBox.zoomIn();};
      zoomOutBtn.onClick = function(){previewBox.zoomOut();};
      zoomFitBtn.onClick = function(){previewBox.zoomFit();};
      zoom100Btn.onClick = function(){previewBox.zoom1to1();};

      var zoomRow = new HorizontalSizer;
      zoomRow.spacing=4; zoomRow.add(zoomLabel); zoomRow.addStretch();
      zoomRow.add(zoomOutBtn); zoomRow.add(zoomInBtn);
      zoomRow.addSpacing(6); zoomRow.add(zoomFitBtn); zoomRow.add(zoom100Btn);

      var previewStatusLabel = new Label(this);
      previewStatusLabel.text="No preview rendered";
      previewStatusLabel.styleSheet="color:#667799;font-size:9px;font-style:italic;";

      // Right panel sizer
      var rightSizer = new VerticalSizer;
      rightSizer.spacing=4;
      rightSizer.add(previewBox,100);
      rightSizer.add(zoomRow);
      rightSizer.add(previewStatusLabel);

      // Left panel sizer
      var leftSizer = new VerticalSizer;
      leftSizer.spacing=8;
      leftSizer.add(imgRow);
      leftSizer.add(modeLabel);
      leftSizer.add(passRow);
      leftSizer.add(starsScaleCtrl);
      leftSizer.add(starsBPSigmaCtrl);
      leftSizer.add(starsSatCtrl);
      leftSizer.add(normalBPSigmaCtrl);
      leftSizer.add(targetBgCtrl);
      leftSizer.add(spRangeCtrl);
      leftSizer.add(optGroup);
      leftSizer.add(statsBox,100);
      leftSizer.add(btnRow);
      leftSizer.add(footerLabel);

      // Main layout
      var mainRow = new HorizontalSizer;
      mainRow.spacing=10;
      mainRow.add(leftSizer);
      mainRow.add(rightSizer,100);

      this.sizer = new VerticalSizer;
      this.sizer.margin=10; this.sizer.spacing=8;
      this.sizer.add(headerLabel);
      this.sizer.add(modeGroup);
      this.sizer.add(mainRow,100);
      // ---- Preview logic ----
      var previewWin = null;

      previewBtn.onClick = function() {
         if (!isParams.sourceId) return;
         var srcWin = ImageWindow.windowById(isParams.sourceId);
         if (!srcWin||srcWin.isNull) return;

         // Build stats text
         var txt = "";
         if (isParams.starsOnly) {
            txt = "Mode: Stars Only (rational)\n\n";
            // Compute BP and clip% from source image for display
            var _stImg = srcWin.mainView.image;
            var _stBP  = is_bpFromSigma(_stImg, isParams.starsBPSigma);
            var _stStep = Math.max(1,Math.floor(Math.sqrt((_stImg.width*_stImg.height)/80000)));
            var _stCount=0, _stSamples=0;
            for (var _sty=0;_sty<_stImg.height;_sty+=_stStep) for (var _stx=0;_stx<_stImg.width;_stx+=_stStep) {
               if (_stImg.sample(_stx,_sty,0)<=_stBP) _stCount++;
               _stSamples++;
            }
            var _stClipPct = (_stCount/Math.max(1,_stSamples)*100).toFixed(2);
            txt += "Stretch amount: " + isParams.starsScale.toFixed(2) + "\n";
            txt += "Iterations:     " + isParams.numPasses + "\n";
            txt += "Per-pass amt:   " + (isParams.starsScale / isParams.numPasses).toFixed(2) + "\n";
            txt += "Saturation:     " + isParams.starsSat.toFixed(2) + "\n";
            txt += "BP:             " + _stBP.toFixed(5) + "\n";
            txt += "Clipped:        " + _stClipPct + "%\n";
         } else {
            var plan = is_buildPlan(srcWin.mainView.image, isParams);
            txt = "Stretch plan:\n";
            // Compute clip% for first iter BP on source image
            var _sImg = srcWin.mainView.image;
            var _sStep = Math.max(1,Math.floor(Math.sqrt((_sImg.width*_sImg.height)/80000)));
            var _sCount=0, _sSamples=0;
            var _sBP = plan.length>0 ? plan[0].bp : 0;
            for (var _sy=0;_sy<_sImg.height;_sy+=_sStep) for (var _sx=0;_sx<_sImg.width;_sx+=_sStep) {
               if (_sImg.sample(_sx,_sy,0)<=_sBP) _sCount++;
               _sSamples++;
            }
            var _sClipPct = (_sCount/Math.max(1,_sSamples)*100).toFixed(2);
            for (var i=0;i<plan.length;i++) {
               var p=plan[i];
               txt += "Iter "+p.pass+":  BP="+p.bp.toFixed(5)+"  SP="+p.sp.toFixed(5)+"  b="+p.b.toFixed(0)+"  tBg="+p.targetBg.toFixed(2)+"\n";
            }
            txt += "\nTarget bg:    "+isParams.targetBackground.toFixed(2);
            txt += "\nSP range:     "+isParams.spRange.toFixed(2);
            txt += "\nShadows clip: "+isParams.normalBPSigma.toFixed(2);
            txt += "\nClipped:      "+_sClipPct+"%";
         }
         statsBox.text = txt;

         // Build preview copy
         if (previewWin && !previewWin.isNull) previewWin.forceClose();
         var img = srcWin.mainView.image;
         previewWin = new ImageWindow(img.width,img.height,img.numberOfChannels,
            img.bitsPerSample,img.isReal,img.isColor,"_IS_preview");
         previewWin.mainView.beginProcess(UndoFlag.NoSwapFile);
         previewWin.mainView.image.assign(img);
         previewWin.mainView.endProcess();
         if (isParams.starsOnly)
            is_applyStarsStretch(previewWin.mainView, isParams.starsScale, isParams.numPasses, isParams.starsSat, isParams.satBoost, isParams.starsBPSigma);
         else
            is_applyStretch(previewWin.mainView, isParams);
         var bmp = previewWin.mainView.image.render();
         previewBox.setBitmap(bmp);
         previewBox.zoomFit();
         previewWin.forceClose(); previewWin=null;
         previewStatusLabel.text = (isParams.starsOnly?"Stars Only":"Normal") + " preview rendered  |  scroll=pan  wheel=zoom";
      };

      applyBtn.onClick = function() {
         if (!isParams.sourceId) {
            (new MessageBox("No source image selected.",SCRIPT_TITLE,StdIcon.Error,StdButton.Ok)).execute();
            return;
         }
         var srcWin = ImageWindow.windowById(isParams.sourceId);
         if (!srcWin||srcWin.isNull) {
            (new MessageBox("Source image not found.",SCRIPT_TITLE,StdIcon.Error,StdButton.Ok)).execute();
            return;
         }
         is_saveSettings(isParams);
         var img=srcWin.mainView.image;
         var copyId=isParams.sourceId+"_IS";
         var copyWin=new ImageWindow(img.width,img.height,img.numberOfChannels,
            img.bitsPerSample,img.isReal,img.isColor,copyId);
         copyWin.mainView.beginProcess(UndoFlag.NoSwapFile);
         copyWin.mainView.image.assign(img);
         copyWin.mainView.endProcess();
         if(srcWin.hasAstrometricSolution)copyWin.copyAstrometricSolution(srcWin);
         copyWin.keywords=srcWin.keywords;
         copyWin.show();
         console.writeln();
         console.writeln("  ======================================");
         console.writeln("  "+SCRIPT_TITLE+" v"+SCRIPT_VERSION);
         console.writeln("  Source: "+isParams.sourceId);
         console.writeln("  Output: "+copyId);
         console.writeln("  ======================================");
         if (isParams.starsOnly)
            is_applyStarsStretch(copyWin.mainView, isParams.starsScale, isParams.numPasses, isParams.starsSat, isParams.satBoost, isParams.starsBPSigma);
         else
            is_applyStretch(copyWin.mainView, isParams);
         copyWin.zoomToFit();
         console.writeln("  Complete: "+copyId);
         console.writeln("  ======================================");
         previewStatusLabel.text="Applied to "+copyId;
      };
      updateModeVisibility();
      this.adjustToContents();
   }
};

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
   console.show();
   var dlg = new ISDialog();
   dlg.execute();
}

main();