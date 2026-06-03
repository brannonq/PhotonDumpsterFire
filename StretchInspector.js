#engine v8

#feature-id    StretchInspector : PhotonDumpsterFire > StretchInspector
#feature-icon  StretchInspector.svg
#feature-info  Runs multiple stretch algorithms on a linear source image and displays
#feature-info  the results in a single comparison mosaic.

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

// =========================================================================
// Script metadata
// =========================================================================
var SCRIPT_TITLE   = "StretchInspector";
var SCRIPT_VERSION = "1.0";

// =========================================================================
// Bill Blanchard stretch expressions (V6)
// Author: Bill Blanshan
// Used with permission for non-commercial educational purposes.
// =========================================================================
var BB_SYMBOLS = "Stretch,Curve,Clip,m,d,E1,E2,E3,E4,E5,E6,E7";

var BB_LINKED_EXPR =
   "m=(med($T[0])+med($T[1])+med($T[2]))/3;\n" +
   "d=(mdev($T[0])+mdev($T[1])+mdev($T[2]))/3;\n" +
   "E1=min(max(0,m+-2.8*1.4826*d),1);\n" +
   "E2=max(0,($T-E1)/~E1);\n" +
   "E3=med($T)-E1;\n" +
   "E4=min(1,(1/1.00));\n" +
   "E5=((0.20-1)*E3)/((2*0.20-1)*E3^E4-0.20);\n" +
   "E6=((E5-1)*E2)/((2*E5-1)*E2^E4-E5);\n" +
   "E6";

var BB_UNLINKED_EXPR =
   "E1=min(max(0,med($T)+-2.8*1.4826*mdev($T)),1);\n" +
   "E2=max(0,($T-E1)/~E1);\n" +
   "E3=med($T)-E1;\n" +
   "E4=min(1,(1/1.00));\n" +
   "E5=((0.20-1)*E3)/((2*0.20-1)*E3^E4-0.20);\n" +
   "E6=((E5-1)*E2)/((2*E5-1)*E2^E4-E5);\n" +
   "E6";

// =========================================================================
// Statistical Stretch core — adapted from Statistical Stretch v2.3
// Author: Franklin Marek / Seti Astro (www.setiastro.com)
// License: CC BY-NC 4.0 (http://creativecommons.org/licenses/by-nc/4.0/)
// =========================================================================

function si_statStretchMono( view, targetMedian ) {
   var P = new ProcessContainer;
   var P1 = new PixelMath;
   P1.expression =
      "Med=med($T);\n" +
      "Sig=1.4826*MAD($T);\n" +
      "BPraw=Med-5.0*Sig;\n" +
      "BP=iif(BPraw<min($T),min($T),BPraw);\n" +
      "($T-BP)/(1-BP);";
   P1.useSingleExpression=true; P1.symbols="Med,Sig,BPraw,BP";
   P1.generateOutput=true; P1.rescale=false; P1.truncate=true;
   P1.createNewImage=false; P1.showNewImage=false;
   P.add(P1);
   var P2 = new PixelMath;
   P2.expression = "((med($T)-1)*"+targetMedian.toFixed(4)+"*$T)/(med($T)*("+targetMedian.toFixed(4)+"+$T-1)-"+targetMedian.toFixed(4)+"*$T);";
   P2.useSingleExpression=true;
   P2.generateOutput=true; P2.rescale=false; P2.truncate=false;
   P2.createNewImage=false; P2.showNewImage=false;
   P.add(P2);
   var P3 = new PixelMath;
   P3.expression = "$T;"; P3.useSingleExpression=true;
   P3.generateOutput=true; P3.rescale=false; P3.truncate=true;
   P3.createNewImage=false; P3.showNewImage=false;
   P.add(P3);
   P.executeOn( view );
}

function si_statStretchColor( view, targetMedian ) {
   var P = new ProcessContainer;
   var P1 = new PixelMath;
   P1.expression =
      "cr=0.2126;cg=0.7152;cb=0.0722;\n" +
      "Med=cr*med($T[0])+cg*med($T[1])+cb*med($T[2]);\n" +
      "Sig=1.4826*(cr*MAD($T[0])+cg*MAD($T[1])+cb*MAD($T[2]));\n" +
      "MinC=min(min($T[0]),min($T[1]),min($T[2]));\n" +
      "BPraw=Med-5.0*Sig;\n" +
      "BP=iif(BPraw<MinC,MinC,BPraw);\n" +
      "($T-BP)/(1-BP);";
   P1.useSingleExpression=true; P1.symbols="cr,cg,cb,Med,Sig,MinC,BPraw,BP";
   P1.generateOutput=true; P1.rescale=false; P1.truncate=true;
   P1.createNewImage=false; P1.showNewImage=false;
   P.add(P1);
   var P2 = new PixelMath;
   P2.expression = "MedianColor=avg(med($T[0]),med($T[1]),med($T[2]));\n" +
      "((MedianColor-1)*"+targetMedian.toFixed(4)+"*$T)/(MedianColor*("+targetMedian.toFixed(4)+"+$T-1)-"+targetMedian.toFixed(4)+"*$T);";
   P2.useSingleExpression=true; P2.symbols="MedianColor";
   P2.generateOutput=true; P2.rescale=false; P2.truncate=false;
   P2.createNewImage=false; P2.showNewImage=false;
   P.add(P2);
   var P3 = new PixelMath;
   P3.expression = "$T;"; P3.useSingleExpression=true;
   P3.generateOutput=true; P3.rescale=false; P3.truncate=true;
   P3.createNewImage=false; P3.showNewImage=false;
   P.add(P3);
   P.executeOn( view );
}

// =========================================================================
// VeraLux HyperMetric Stretch core — adapted from VeraLux v1.5.2
// Original Python: Riccardo Paterniti, GPL-3.0-or-later (info@veralux.space)
// V8 PJSR port reference: lucasssvaz / killerciao
// This embedded version uses Rec.709 weights and Ready-to-Use mode defaults.
// =========================================================================

function si_veraluxStretch( view ) {
   var img = view.image;
   var nc = img.numberOfChannels;
   var isRGB = nc >= 3;
   var weights = [0.2126, 0.7152, 0.0722]; // Rec.709

   // Build normalized float32 working image
   var work = new Image(img.width, img.height, nc,
      isRGB ? ColorSpace.RGB : ColorSpace.Gray, 32, PixelSampleType.Float);
   work.assign(img);
   var mx = work.maximum();
   if (mx > 1.1) { var div = mx < 100000 ? 65535 : 4294967295; work.apply(1/div, ImageOp.Mul); }
   work.truncate(0, work.maximum());

   // Adaptive anchor via histogram peak analysis
   function calcAnchor(image) {
      var w=image.width, h=image.height, n=w*h;
      var stride = Math.max(1, Math.floor(n/2000000));
      var nBins=65536, hist=new Float64Array(nBins);
      if (isRGB) {
         var Ir=new ImageIterator(image,0),Ig=new ImageIterator(image,1),Ib=new ImageIterator(image,2);
         var wr=weights[0],wg=weights[1],wb=weights[2];
         for (var i=0;i<n;i+=stride){var x=i%w,y=(i/w)|0;var v=wr*Ir[y][x]+wg*Ig[y][x]+wb*Ib[y][x];var bin=(v*(nBins-1))|0;if(bin>=0&&bin<nBins)hist[bin]++;}
      } else {
         var Im=new ImageIterator(image,0);
         for (var i=0;i<n;i+=stride){var x=i%w,y=(i/w)|0;var v=Im[y][x];var bin=(v*(nBins-1))|0;if(bin>=0&&bin<nBins)hist[bin]++;}
      }
      var smoothed=new Float64Array(nBins),win=50,sum=0;
      for(var k=0;k<win&&k<nBins;k++)sum+=hist[k];
      for(var k=0;k<nBins;k++){if(k+win<nBins)sum+=hist[k+win];if(k-win-1>=0)sum-=hist[k-win-1];var cnt=Math.min(k+win,nBins-1)-Math.max(k-win,0)+1;smoothed[k]=sum/cnt;}
      var peakIdx=100,peakVal=0;
      for(var k=100;k<nBins;k++)if(smoothed[k]>peakVal){peakVal=smoothed[k];peakIdx=k;}
      var target=peakVal*0.06,anchorIdx=-1;
      for(var k=peakIdx-1;k>=0;k--)if(smoothed[k]<target){anchorIdx=k;break;}
      if(anchorIdx<0){image.selectedChannel=0;var m=image.median();image.resetSelections();return Math.max(0,m);}
      return Math.max(0,anchorIdx/(nBins-1));
   }

   var anchor = calcAnchor(work);
   var logD=2.0, bVal=6.0;
   var D=Math.pow(10,logD);

   // Build stretched luminance
   var lumStr=new Image(img.width,img.height,1,ColorSpace.Gray,32,PixelSampleType.Float);
   var t2=Math.asinh(bVal);
   var norm=Math.asinh(D+bVal)-t2;
   if(Math.abs(norm)<1e-12)norm=1e-6;
   var IL=new ImageIterator(lumStr,0);
   if(isRGB){
      var Ir=new ImageIterator(work,0),Ig=new ImageIterator(work,1),Ib=new ImageIterator(work,2);
      var wr=weights[0],wg=weights[1],wb=weights[2];
      for(var y=0;y<img.height;y++){var ir=Ir[y],ig=Ig[y],ib=Ib[y],il=IL[y];for(var x=0;x<img.width;x++){var r=ir[x]-anchor;if(r<0)r=0;var g=ig[x]-anchor;if(g<0)g=0;var bv=ib[x]-anchor;if(bv<0)bv=0;var L=wr*r+wg*g+wb*bv;var s=(Math.asinh(D*L+bVal)-t2)/norm;il[x]=s<0?0:s>1?1:s;}}
   } else {
      var Im=new ImageIterator(work,0);
      for(var y=0;y<img.height;y++){var im=Im[y],il=IL[y];for(var x=0;x<img.width;x++){var v=im[x]-anchor;if(v<0)v=0;var s=(Math.asinh(D*v+bVal)-t2)/norm;il[x]=s<0?0:s>1?1:s;}}
   }

   // Color reconstruction
   var result=new Image(img.width,img.height,nc,isRGB?ColorSpace.RGB:ColorSpace.Gray,32,PixelSampleType.Float);
   var convPow=3.5, pedestal=0.005, oneMP=1-pedestal, eps=1e-9;
   if(isRGB){
      var Ir=new ImageIterator(work,0),Ig=new ImageIterator(work,1),Ib=new ImageIterator(work,2);
      var Or=new ImageIterator(result,0),Og=new ImageIterator(result,1),Ob=new ImageIterator(result,2);
      var wr=weights[0],wg=weights[1],wb=weights[2];
      for(var y=0;y<img.height;y++){var ir=Ir[y],ig=Ig[y],ib=Ib[y],il=IL[y],or_=Or[y],og=Og[y],ob=Ob[y];for(var x=0;x<img.width;x++){var r=ir[x]-anchor;if(r<0)r=0;var g=ig[x]-anchor;if(g<0)g=0;var bv=ib[x]-anchor;if(bv<0)bv=0;var Lv=wr*r+wg*g+wb*bv;var Ls=il[x];var k=Math.pow(Ls,convPow);var omk=1-k;var rF=Ls*((r/(Lv+eps))*omk+k);var gF=Ls*((g/(Lv+eps))*omk+k);var bF=Ls*((bv/(Lv+eps))*omk+k);or_[x]=rF*oneMP+pedestal;og[x]=gF*oneMP+pedestal;ob[x]=bF*oneMP+pedestal;}}
   } else {
      var Or=new ImageIterator(result,0);
      for(var y=0;y<img.height;y++){var il=IL[y],or_=Or[y];for(var x=0;x<img.width;x++){or_[x]=il[x]*oneMP+pedestal;}}
   }
   work.free(); lumStr.free();

   // Adaptive output scaling with Smart-Max physical limit check
   // Matches VeraLux 1.5.2 adaptiveOutputScaling exactly
   function sampleLuma2(image){
      var w=image.width,h=image.height,n=w*h,stride=Math.max(1,Math.floor(n/500000)),arr=[];
      if(isRGB){var Ir=new ImageIterator(image,0),Ig=new ImageIterator(image,1),Ib=new ImageIterator(image,2),wr=weights[0],wg=weights[1],wb=weights[2];for(var i=0;i<n;i+=stride){var x2=i%w,y2=(i/w)|0;arr.push(wr*Ir[y2][x2]+wg*Ig[y2][x2]+wb*Ib[y2][x2]);}}
      else{var Im=new ImageIterator(image,0);for(var i=0;i<n;i+=stride){var x2=i%w,y2=(i/w)|0;arr.push(Im[y2][x2]);}}
      arr.sort(function(a,b){return a-b;}); return arr;
   }
   function pct(sorted,p){var n=sorted.length;if(n===0)return 0;var idx=(p/100)*(n-1);var lo=Math.floor(idx),hi=Math.ceil(idx);if(hi>=n)return sorted[n-1];return sorted[lo]*(1-(idx-lo))+sorted[hi]*(idx-lo);}
   var lumas=sampleLuma2(result);
   var median=pct(lumas,50),mean=0;
   for(var i=0;i<lumas.length;i++)mean+=lumas[i]; mean/=lumas.length;
   var std=0; for(var i=0;i<lumas.length;i++){var dv=lumas[i]-mean;std+=dv*dv;} std=Math.sqrt(std/lumas.length);
   var globalFloor=Math.max(lumas[0],median-2.7*std);
   var PEDESTAL=0.001;
   // Smart-Max physical limit check
   var absMax=-Infinity,xMax=0,yMax=0;
   if(isRGB){var Ir=new ImageIterator(result,0),Ig=new ImageIterator(result,1),Ib=new ImageIterator(result,2),wr=weights[0],wg=weights[1],wb=weights[2];for(var y=0;y<result.height;y++){var ir=Ir[y],ig=Ig[y],ib=Ib[y];for(var x=0;x<result.width;x++){var Lv=wr*ir[x]+wg*ig[x]+wb*ib[x];if(Lv>absMax){absMax=Lv;xMax=x;yMax=y;}}}}
   else{var Im=new ImageIterator(result,0);for(var y=0;y<result.height;y++){var im=Im[y];for(var x=0;x<result.width;x++)if(im[x]>absMax){absMax=im[x];xMax=x;yMax=y;}}}
   var validPhysical=true;
   if(absMax>0.001){
      var y0v=Math.max(0,yMax-1),y1v=Math.min(result.height,yMax+2),x0v=Math.max(0,xMax-1),x1v=Math.min(result.width,xMax+2);
      var maxNeighbor=-Infinity,anyNeighbor=false;
      if(isRGB){var Ir2=new ImageIterator(result,0),Ig2=new ImageIterator(result,1),Ib2=new ImageIterator(result,2),wr2=weights[0],wg2=weights[1],wb2=weights[2];for(var y=y0v;y<y1v;y++){var ir=Ir2[y],ig=Ig2[y],ib=Ib2[y];for(var x=x0v;x<x1v;x++){var Lv=wr2*ir[x]+wg2*ig[x]+wb2*ib[x];if(Lv<absMax){anyNeighbor=true;if(Lv>maxNeighbor)maxNeighbor=Lv;}}}}
      else{var Im2=new ImageIterator(result,0);for(var y=y0v;y<y1v;y++){var im2=Im2[y];for(var x=x0v;x<x1v;x++){var Lv=im2[x];if(Lv<absMax){anyNeighbor=true;if(Lv>maxNeighbor)maxNeighbor=Lv;}}}}
      if(anyNeighbor&&maxNeighbor<absMax*0.20)validPhysical=false;
   }
   var softCeil;
   if(isRGB){var cs0=[],cs1=[],cs2=[],str2=Math.max(1,Math.floor(result.width*result.height/500000));var Ir3=new ImageIterator(result,0),Ig3=new ImageIterator(result,1),Ib3=new ImageIterator(result,2);for(var y=0;y<result.height;y++){var ir=Ir3[y],ig=Ig3[y],ib=Ib3[y];for(var x=0;x<result.width;x+=str2){cs0.push(ir[x]);cs1.push(ig[x]);cs2.push(ib[x]);}}cs0.sort(function(a,b){return a-b;});cs1.sort(function(a,b){return a-b;});cs2.sort(function(a,b){return a-b;});softCeil=Math.max(pct(cs0,99),pct(cs1,99),pct(cs2,99));}
   else{var cs=[],Im3=new ImageIterator(result,0);for(var y=0;y<result.height;y++){var im3=Im3[y];for(var x=0;x<result.width;x++)cs.push(im3[x]);}cs.sort(function(a,b){return a-b;});softCeil=pct(cs,99);}
   if(softCeil<=globalFloor)softCeil=globalFloor+1e-6;
   if(absMax<=softCeil)absMax=softCeil+1e-6;
   var scaleC=(0.98-PEDESTAL)/(softCeil-globalFloor+1e-9);
   var finalScale=validPhysical?Math.min(scaleC,(1.0-PEDESTAL)/(absMax-globalFloor+1e-9)):scaleC;
   for(var c=0;c<nc;c++){var I=new ImageIterator(result,c);for(var y=0;y<result.height;y++){var row=I[y];for(var x=0;x<result.width;x++){var v=(row[x]-globalFloor)*finalScale+PEDESTAL;row[x]=v<0?0:v>1?1:v;}}}
   // Soft clip
   for(var c=0;c<nc;c++){var I=new ImageIterator(result,c);for(var y=0;y<result.height;y++){var row=I[y];for(var x=0;x<result.width;x++){var v=row[x];if(v>0.98){var t=(v-0.98)/0.02;if(t>1)t=1;row[x]=0.98+0.02*(1-Math.pow(1-t,2));}}}}
   // MTF to target background 0.20
   var lumas2=sampleLuma2(result),curBg=pct(lumas2,50),targetBg=0.20;
   if(curBg>0&&curBg<1&&Math.abs(curBg-targetBg)>1e-3){var m=(curBg*(targetBg-1))/(curBg*(2*targetBg-1)-targetBg);for(var c=0;c<nc;c++){var I=new ImageIterator(result,c);for(var y=0;y<result.height;y++){var row=I[y];for(var x=0;x<result.width;x++){var v=row[x];if(v<=0)row[x]=0;else if(v>=1)row[x]=1;else{var num=(m-1)*v;var den=(2*m-1)*v-m;if(Math.abs(den)<1e-12)row[x]=v;else{var r=num/den;row[x]=r<0?0:r>1?1:r;}}}}}}

   // Bake result back into view
   view.beginProcess(UndoFlag.NoSwapFile);
   view.image.assign(result);
   view.endProcess();
   result.free();
}

// =========================================================================
// Utilities
// =========================================================================

function si_getAllWindowIds() {
   var ids = [];
   var wins = ImageWindow.windows;
   for (var i=0; i<wins.length; i++) ids.push(wins[i].mainView.id);
   return ids;
}

function si_formatElapsed(ms) {
   var s = ms/1000;
   if (s < 60) return s.toFixed(1)+"s";
   return Math.floor(s/60)+"m "+(s%60).toFixed(0)+"s";
}

// =========================================================================
// Stretch runners — each returns correctedId
// =========================================================================

function si_makeClone( srcView, suffix ) {
   var img = srcView.image;
   var cloneWin = new ImageWindow(img.width, img.height, img.numberOfChannels,
      img.bitsPerSample, img.isReal, img.isColor);
   cloneWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   cloneWin.mainView.image.assign(img);
   cloneWin.mainView.endProcess();
   cloneWin.mainView.id = srcView.id + suffix;
   cloneWin.show();
   return cloneWin;
}

function si_runHT( srcView ) {
   var cloneWin = si_makeClone(srcView, "_SI_HT");
   var view = cloneWin.mainView;
   var img = view.image;
   var nCh = img.numberOfChannels;
   var B=0.25, C=-2.8;
   function htRow(ch){
      img.selectedChannel=ch;
      var med=img.median(), mad=img.MAD();
      img.resetSelections();
      mad=mad>0?mad*1.4826:1e-10;
      var shad=Math.max(0,med+C*mad);
      var range=med-shad;
      var mid=range>0?(B*range)/((2*B-1)*range-B):0.5;
      return [Math.max(0.001,Math.min(0.999,mid)) ? [shad,Math.max(0.001,Math.min(0.999,mid)),1,0,1] : [shad,0.5,1,0,1]];
   }
   var identity=[0,0.5,1,0,1];
   var ht = new HistogramTransformation;
   if (nCh===1) {
      var k=htRow(0)[0]; ht.H=[identity,identity,identity,k,identity];
   } else {
      var r=htRow(0)[0],g=htRow(1)[0],bv=htRow(2)[0];
      ht.H=[r,g,bv,identity,identity];
   }
   ht.executeOn(view);
   return cloneWin.mainView.id;
}

function si_runMAS( srcView ) {
   var cloneWin = si_makeClone(srcView, "_SI_MAS");
   var mas = new MultiscaleAdaptiveStretch;
   mas.targetBackground          = 0.20;
   mas.aggressiveness            = 0.75;
   mas.dynamicRangeCompression   = 0.40;
   mas.contrastRecovery          = true;
   mas.scaleSeparation           = 1024;
   mas.contrastRecoveryIntensity = 1.0;
   mas.colorSaturation           = true;
   mas.colorSaturationAmount     = 0.5;
   mas.colorSaturationBoost      = 0.5;
   mas.executeOn(cloneWin.mainView);
   return cloneWin.mainView.id;
}

function si_runBillLinked( srcView ) {
   var cloneWin = si_makeClone(srcView, "_SI_BBL");
   var pm = new PixelMath;
   pm.useSingleExpression = true;
   pm.expression = BB_LINKED_EXPR;
   pm.symbols = BB_SYMBOLS;
   pm.generateOutput=true; pm.rescale=false; pm.truncate=true;
   pm.createNewImage=false; pm.showNewImage=false;
   pm.executeOn(cloneWin.mainView);
   return cloneWin.mainView.id;
}


// IterativeStretch — progressive multi-pass HT stretch
// Defaults: 3 passes, targetBackground 0.20, spRange 0.50, shadowsSigma -2.80
function si_runIterativeStretch( srcView ) {
   var cloneId  = "_SI_IS";
   var cloneWin = si_makeClone( srcView, cloneId );
   if ( !cloneWin ) return null;

   var img      = cloneWin.mainView.image;
   var isColor  = img.numberOfChannels >= 3;
   var nPasses  = 3;
   var tgtBg    = 0.20;
   var spRange  = 0.50;
   var sigmaC   = -2.80;

   // IS helper functions (inline, no external dependency)
   function _mergedStats( image ) {
      var nc = image.numberOfChannels;
      var sum = { mean:0, median:0, p001:0, p005:0, p50:0, p90:0, sigma:0 };
      for ( var ch = 0; ch < Math.min(nc,3); ch++ ) {
         image.selectedChannel = ch;
         var med = image.median(); var mad = image.MAD() * 1.4826;
         sum.median += med; sum.sigma += (mad>0?mad:1e-10);
         sum.p50 += med;
      }
      image.resetSelections();
      var n = Math.min(nc,3);
      sum.median /= n; sum.sigma /= n; sum.p50 /= n;
      sum.p001 = Math.max(0, sum.median - 3.0*sum.sigma);
      sum.p005 = Math.max(0, sum.median - 2.5*sum.sigma);
      sum.p90  = Math.min(1, sum.median + spRange * (1.0 - sum.median));
      return sum;
   }
   function _bpFromSigma( image, C ) {
      var nc = image.numberOfChannels; var minBP = 1.0;
      for ( var ch = 0; ch < Math.min(nc,3); ch++ ) {
         image.selectedChannel = ch;
         var med = image.median(); var mad = image.MAD();
         image.resetSelections();
         mad = (mad>0) ? mad*1.4826 : 1e-10;
         var bp = Math.max(0, med + C*mad);
         if (bp < minBP) minBP = bp;
      }
      return minBP;
   }
   function _passIntensity( pass, total ) {
      var t = { 1:[4], 2:[8,1], 3:[8,3,1], 4:[8,4,2,0], 5:[8,5,2,1,0] };
      var tbl = t[total] || t[3];
      return (pass < tbl.length) ? tbl[pass] : 0;
   }
   function _midtones( sp, tBg ) {
      var denom = (2*tBg-1)*sp - tBg;
      return Math.abs(denom)<1e-10 ? 0.5 : Math.max(0.001,Math.min(0.999,((tBg-1)*sp)/denom));
   }
   function _applyIntensity( mid, b ) {
      if (b<=0) return mid;
      return Math.max(0.001,Math.min(0.999, mid/(1.0+b*(1.0-mid))));
   }
   function _sp( stats, pass, total ) {
      var shoulder = stats.p005 + 0.35*(stats.p50-stats.p005);
      var base = (pass===0) ? shoulder : stats.p001 + stats.sigma*0.5;
      var hi   = stats.p50 + spRange*(stats.p90-stats.p50);
      var t    = pass/Math.max(1,total-1);
      return base + t*(hi-base);
   }

   var firstTgt = tgtBg + 0.30;
   for ( var pass = 0; pass < nPasses; pass++ ) {
      var stats  = _mergedStats( cloneWin.mainView.image );
      var bp     = _bpFromSigma( cloneWin.mainView.image, sigmaC );
      var sp     = _sp( stats, pass, nPasses );
      var t      = pass / Math.max(1, nPasses-1);
      var tBg    = firstTgt - t*(firstTgt - tgtBg);
      var b      = _passIntensity( pass, nPasses );
      var range  = 1.0-bp; if(range<1e-10) range=1.0;
      var spNorm = Math.max(0,Math.min(1,(sp-bp)/range));
      var mid    = _applyIntensity( _midtones(spNorm,tBg), b );
      var ht = new HistogramTransformation;
      var id = [0,0.5,1.0,0.0,1.0]; var row = [bp,mid,1.0,0.0,1.0];
      if (!isColor) ht.H=[id,id,id,row,id]; else ht.H=[row,row,row,id,id];
      ht.executeOn( cloneWin.mainView, false );
   }
   return cloneWin;
}

function si_runBillUnlinked( srcView ) {
   var cloneWin = si_makeClone(srcView, "_SI_BBU");
   var pm = new PixelMath;
   pm.useSingleExpression = true;
   pm.expression = BB_UNLINKED_EXPR;
   pm.symbols = BB_SYMBOLS;
   pm.generateOutput=true; pm.rescale=false; pm.truncate=true;
   pm.createNewImage=false; pm.showNewImage=false;
   pm.executeOn(cloneWin.mainView);
   return cloneWin.mainView.id;
}

function si_runStatStretch( srcView ) {
   var cloneWin = si_makeClone(srcView, "_SI_SS");
   var img = cloneWin.mainView.image;
   if (img.numberOfChannels === 1)
      si_statStretchMono(cloneWin.mainView, 0.25);
   else
      si_statStretchColor(cloneWin.mainView, 0.25);
   return cloneWin.mainView.id;
}

function si_runVeraLux( srcView ) {
   var cloneWin = si_makeClone(srcView, "_SI_VL");
   si_veraluxStretch(cloneWin.mainView);
   return cloneWin.mainView.id;
}

// =========================================================================
// Mosaic builder
// =========================================================================

function si_buildMosaic( results, sourceId ) {
   var SEP      = 4;
   var LABEL_H  = 28;
   var TARGET_W = 1200;

   // Compute tile dimensions from first successful result
   var srcWin = null;
   for (var i=0; i<results.length; i++) {
      if (!results[i].failed) { srcWin = ImageWindow.windowById(results[i].correctedId); break; }
   }
   if (!srcWin || srcWin.isNull) { console.writeln("  No results to mosaic."); return null; }
   var srcImg  = srcWin.mainView.image;
   var tileW   = TARGET_W;
   var tileH   = Math.round(tileW * srcImg.height / srcImg.width);
   var nCols   = Math.min(3, results.length);
   var nRows   = Math.ceil(results.length / 3);
   var totalW  = SEP + nCols*(tileW+SEP);
   var totalH  = SEP + nRows*(LABEL_H+SEP+tileH+SEP);

   // Label colours per tool
   var COLOURS = {
      "HT Auto-Stretch":          [0x22,0x55,0xaa],
      "MAS":                       [0x22,0x66,0x22],
      "Bill Linked":               [0xaa,0x66,0x22],
      "IterativeStretch":          [0x22,0x88,0xaa],
      "Statistical Stretch":       [0x15,0x77,0x88],
      "VeraLux":                   [0x77,0x22,0x22]
   };

   // Find or create mosaic window
   var mosaicId = "StretchInspector_Result";
   var existing = ImageWindow.windowById(mosaicId);
   var counter = 1;
   while (existing && !existing.isNull) {
      counter++;
      mosaicId = "StretchInspector_Result_" + counter;
      existing = ImageWindow.windowById(mosaicId);
   }

   var mosaicWin = new ImageWindow(totalW, totalH, 3, 32, true, true, mosaicId);
   mosaicWin.mainView.beginProcess(UndoFlag.NoSwapFile);
   mosaicWin.mainView.image.fill(0.05); // dark grey background
   mosaicWin.mainView.endProcess();
   // Keep hidden during build — show after complete

   function drawLabelBar(col, row, label, rgb) {
      var x0 = SEP + col*(tileW+SEP);
      var y0 = SEP + row*(LABEL_H+SEP+tileH+SEP);
      var bmp = new Bitmap(tileW, LABEL_H);
      bmp.fill(0xff000000 | (rgb[0]<<16) | (rgb[1]<<8) | rgb[2]);
      var g = new Graphics(bmp);
      g.pen = new Pen(0xffffffff);
      g.font = new Font(FontFamily.SansSerif, 11);
      g.font.bold = true;
      var tw = g.font.width(label);
      var th = g.font.ascent;
      g.drawText(Math.floor((tileW-tw)/2), Math.floor((LABEL_H+th)/2)-2, label);
      g.end();
      mosaicWin.mainView.beginProcess();
      var mi = mosaicWin.mainView.image;
      for (var py=0; py<LABEL_H; py++)
         for (var px=0; px<tileW; px++) {
            var pixel = bmp.pixel(px,py);
            mi.setSample(((pixel>>16)&0xff)/255, x0+px, y0+py, 0);
            mi.setSample(((pixel>>8)&0xff)/255,  x0+px, y0+py, 1);
            mi.setSample((pixel&0xff)/255,        x0+px, y0+py, 2);
         }
      mosaicWin.mainView.endProcess();
   }

   function blitTile(winId, col, row) {
      var sw = ImageWindow.windowById(winId);
      if (!sw || sw.isNull) return;
      var si2 = sw.mainView.image;
      var tmp = new ImageWindow(si2.width, si2.height, si2.numberOfChannels,
         32, true, si2.isColor);
      tmp.mainView.beginProcess(UndoFlag.NoSwapFile);
      tmp.mainView.image.assign(si2);
      tmp.mainView.endProcess();

      // Resample to tile size
      if (tmp.mainView.image.width !== tileW || tmp.mainView.image.height !== tileH) {
         var rs = new Resample;
         rs.xSize = tileW / tmp.mainView.image.width;
         rs.ySize = tileH / tmp.mainView.image.height;
         rs.mode  = Resample.RelativeDimensions;
         rs.executeOn(tmp.mainView);
      }

      var src   = tmp.mainView.image;
      var destX = SEP + col*(tileW+SEP);
      var destY = SEP + row*(LABEL_H+SEP+tileH+SEP) + LABEL_H + SEP;
      var copyW = Math.min(src.width,  totalW-destX);
      var copyH = Math.min(src.height, totalH-destY);
      var nChS  = src.numberOfChannels;
      mosaicWin.mainView.beginProcess();
      var mi = mosaicWin.mainView.image;
      for (var y=0; y<copyH; y++)
         for (var x=0; x<copyW; x++) {
            mi.setSample(src.sample(x,y,0),          destX+x, destY+y, 0);
            mi.setSample(src.sample(x,y,nChS>1?1:0), destX+x, destY+y, 1);
            mi.setSample(src.sample(x,y,nChS>2?2:0), destX+x, destY+y, 2);
         }
      mosaicWin.mainView.endProcess();
      tmp.forceClose();
   }

   // Draw each column
   var colSummary = [];
   for (var i=0; i<results.length; i++) {
      var r = results[i];
      var col = i % 3;
      var row = Math.floor(i / 3);
      var rgb = COLOURS[r.label] || [0x44,0x44,0x44];
      drawLabelBar(col, row, r.label, rgb);
      if (r.failed) {
         // Red error tile
         var col2 = i % 3;
         var row2 = Math.floor(i / 3);
         var x0 = SEP + col2*(tileW+SEP);
         var y0 = SEP + row2*(LABEL_H+SEP+tileH+SEP) + LABEL_H + SEP;
         mosaicWin.mainView.beginProcess();
         var mi = mosaicWin.mainView.image;
         for (var py=0; py<tileH; py++)
            for (var px=0; px<tileW; px++) {
               mi.setSample(0.25, x0+px, y0+py, 0);
               mi.setSample(0.05, x0+px, y0+py, 1);
               mi.setSample(0.05, x0+px, y0+py, 2);
            }
         mosaicWin.mainView.endProcess();
      } else {
         blitTile(r.correctedId, col, row);
         colSummary.push("  Col "+(i+1)+": "+r.label);
      }
   }

   mosaicWin.show();
   return mosaicId;
}

// =========================================================================
// Apply Winner dialog
// =========================================================================

function si_showApplyWinner( results, sourceId ) {
   var successfulResults = results.filter(function(r){ return !r.failed; });
   if (successfulResults.length === 0) return;

   var dlg = new Dialog();
   dlg.windowTitle = "StretchInspector - Apply Winner";
   dlg.userResizable = false;

   var titleLabel = new Label(dlg);
   titleLabel.text = "Select the stretch to apply to the original image:";
   titleLabel.styleSheet = "font-weight:bold;";

   var radios = [];
   var radioSizer = new VerticalSizer;
   radioSizer.spacing = 6;
   for (var i=0; i<successfulResults.length; i++) {
      var r = new RadioButton(dlg);
      r.text = successfulResults[i].label + " (" + successfulResults[i].elapsed + ")";
      if (i===0) r.checked = true;
      radioSizer.add(r);
      radios.push(r);
   }

   var noteLabel = new Label(dlg);
   noteLabel.text = "Note: This will modify the original image in place.";
   noteLabel.styleSheet = "color:#aa8800;font-size:9px;";

   var applyBtn = new PushButton(dlg);
   applyBtn.text = "Apply to Original";
   applyBtn.icon = dlg.scaledResource(":/icons/ok.png");
   applyBtn.onClick = function() {
      for (var i=0; i<radios.length; i++) {
         if (radios[i].checked) {
            var sel = successfulResults[i];
            var srcWin = ImageWindow.windowById(sourceId);
            var resWin = ImageWindow.windowById(sel.correctedId);
            if (srcWin && !srcWin.isNull && resWin && !resWin.isNull) {
               srcWin.mainView.beginProcess(UndoFlag.NoSwapFile);
               srcWin.mainView.image.assign(resWin.mainView.image);
               srcWin.mainView.endProcess();
               console.writeln("  Applied " + sel.label + " to " + sourceId);
            }
            break;
         }
      }
      dlg.done(1);
   };

   var skipBtn = new PushButton(dlg);
   skipBtn.text = "Skip";
   skipBtn.icon = dlg.scaledResource(":/icons/close.png");
   skipBtn.onClick = function() { dlg.done(0); };

   var btnSizer = new HorizontalSizer;
   btnSizer.spacing = 8;
   btnSizer.add(applyBtn);
   btnSizer.addStretch();
   btnSizer.add(skipBtn);

   dlg.sizer = new VerticalSizer;
   dlg.sizer.margin = 12;
   dlg.sizer.spacing = 10;
   dlg.sizer.add(titleLabel);
   dlg.sizer.add(radioSizer);
   dlg.sizer.add(noteLabel);
   dlg.sizer.add(btnSizer);

   dlg.execute();
}

// =========================================================================
// Help dialog
// =========================================================================
function si_showHelp( parent ) {
   var dlg = new Dialog();
   dlg.windowTitle = "StretchInspector v1.0 - Help";
   dlg.userResizable = true;
   dlg.minWidth = 620;
   dlg.minHeight = 520;

   var helpText = new TextBox(dlg);
   helpText.readOnly = true;
   helpText.useRichText = true;
   helpText.text = "<html><body style='font-family:sans-serif;font-size:10pt;'>" +
      "<h2>StretchInspector v1.0</h2>" +
      "<p>Runs up to six automated stretch algorithms on a single linear source image and displays the results in a comparison mosaic. Each tool gets its own column so you can visually compare how each algorithm handles your data.</p>" +
      "<p>Once you decide which stretch works best, use the Apply Winner dialog to apply it to the original image in one click.</p>" +
      "<hr/><h3>Before You Start</h3>" +
      "<ul><li>Image must be <b>linear</b> (unstretched)</li>" +
      "<li>Gradient correction should already be done</li>" +
      "<li>Background neutralization and color calibration recommended before stretching</li></ul>" +
      "<hr/><h3>The Tools</h3>" +
      "<p><b>HT Auto-Stretch</b> — HistogramTransformation using STF-derived per-channel midtones. Target background 0.25, shadows clipping at 2.8 sigma. Classic PI auto-stretch method.</p>" +
      "<p><b>MAS</b> — MultiscaleAdaptiveStretch. PI's multiscale adaptive stretch. Target background 0.20, aggressiveness 0.75. Preserves fine detail at multiple spatial scales.</p>" +
      "<p><b>Bill Linked</b> — Bill Blanshan's linked PixelMath stretch (V6). Uses average channel median and MAD for a single shared MTF. Target background 0.20, Curve 1.0. Preserves color balance.</p>" +
      "<p><b>IterativeStretch</b> — Progressive multi-pass adaptive HT stretch. 3 passes with decreasing stretch intensity (b=8/3/1), MAS-style shadows clipping at -2.80 sigma, SP walks rightward each pass.</p>" +
      "<p><b>Statistical Stretch</b> — Franklin Marek / Seti Astro (CC BY-NC 4.0, www.setiastro.com). Logarithmic stretch using image statistics. Target background 0.25. Handles high dynamic range well.</p>" +
      "<p><b>VeraLux</b> — Riccardo Paterniti's HyperMetric Stretch (GPL-3.0, www.veralux.space). Photometric inverse-hyperbolic stretch with vector color preservation. Rec.709 weights, Ready-to-Use mode, target background 0.20.</p>" +
      "<hr/><h3>Tips</h3>" +
      "<ul><li>For galaxies, HT and VeraLux tend to preserve core detail well</li>" +
      "<li>For large nebulae, MAS and Statistical Stretch often give good results</li>" +
      "<li>IterativeStretch works well as a balanced all-rounder on most broadband targets</li>" +
      "<li>VeraLux is the slowest tool on large images</li></ul>" +
      "<hr/><h3>Attribution</h3>" +
      "<p><b>Statistical Stretch</b>: Franklin Marek / Seti Astro, CC BY-NC 4.0</p>" +
      "<p><b>VeraLux HyperMetric Stretch</b>: Riccardo Paterniti, GPL-3.0-or-later</p>" +
      "<p><b>Bill Blanshan Stretch V6</b>: Bill Blanshan</p>" +
      "</body></html>";

   var closeBtn = new PushButton(dlg);
   closeBtn.text = "Close";
   closeBtn.onClick = function() { dlg.done(0); };

   var btnSizer = new HorizontalSizer;
   btnSizer.addStretch();
   btnSizer.add(closeBtn);

   dlg.sizer = new VerticalSizer;
   dlg.sizer.margin = 12;
   dlg.sizer.spacing = 8;
   dlg.sizer.add(helpText, 100);
   dlg.sizer.add(btnSizer);

   dlg.execute();
}

// =========================================================================
// Parameters
// =========================================================================
var siParams = {
   sourceId:    "",
   keepWindows: false,
   runHT:       true,
   runMAS:      true,
   runBillL:    true,
   runIS:       true,
   runStatStr:  true,
   runVeraLux:  true
};

// =========================================================================
// Main runner
// =========================================================================
function si_run( sourceId ) {
   var srcWin = ImageWindow.windowById(sourceId);
   if (!srcWin || srcWin.isNull) {
      console.criticalln("StretchInspector: source image not found: " + sourceId);
      return;
   }
   var srcView = srcWin.mainView;

   console.writeln();
   console.writeln("  ========================================");
   console.writeln("  StretchInspector v" + SCRIPT_VERSION);
   console.writeln("  Source: " + sourceId);
   console.writeln("  ========================================");

   var tools = [
      { key:"runHT",      label:"HT Auto-Stretch",    fn: function(v){ return si_runHT(v); } },
      { key:"runMAS",     label:"MAS",                fn: function(v){ return si_runMAS(v); } },
      { key:"runBillL",   label:"Bill Linked",        fn: function(v){ return si_runBillLinked(v); } },
      { key:"runIS",      label:"IterativeStretch",   fn: function(v){ return si_runIterativeStretch(v); } },
      { key:"runStatStr", label:"Statistical Stretch",fn: function(v){ return si_runStatStretch(v); } },
      { key:"runVeraLux", label:"VeraLux",            fn: function(v){ return si_runVeraLux(v); } }
   ];

   var results = [];
   var timingLog = {};

   for (var i=0; i<tools.length; i++) {
      var tool = tools[i];
      if (!siParams[tool.key]) continue;
      console.writeln("  Running: " + tool.label + "...");
      var t0 = Date.now();
      try {
         var correctedId = tool.fn(srcView);
         var elapsed = si_formatElapsed(Date.now()-t0);
         timingLog[tool.label] = elapsed;
         console.writeln("  " + tool.label + ": " + elapsed);
         results.push({ label:tool.label, correctedId:correctedId, failed:false, elapsed:elapsed });
      } catch(e) {
         var elapsed = si_formatElapsed(Date.now()-t0);
         console.criticalln("  " + tool.label + " FAILED: " + e.message);
         results.push({ label:tool.label, correctedId:null, failed:true, elapsed:elapsed, failMsg:e.message });
      }
   }

   // Build mosaic
   console.writeln("  Building comparison mosaic...");
   var mosaicId = si_buildMosaic(results, sourceId);

   // Summary
   console.writeln();
   console.writeln("  ========================================");
   console.writeln("  Complete: " + mosaicId);
   console.writeln("  ----------------------------------------");
   for (var label in timingLog) console.writeln("  " + label + ": " + timingLog[label]);
   console.writeln("  ========================================");

   // Close working windows (unless keepWindows is set)
   if (!siParams.keepWindows) {
      console.writeln("  Closing working windows...");
      for (var i=0; i<results.length; i++) {
         if (!results[i].failed && results[i].correctedId) {
            var w = ImageWindow.windowById(results[i].correctedId);
            if (w && !w.isNull) w.forceClose();
         }
      }
   } else {
      console.writeln("  Keeping result windows open for inspection.");
      for (var i=0; i<results.length; i++) {
         if (!results[i].failed && results[i].correctedId) {
            var w = ImageWindow.windowById(results[i].correctedId);
            if (w && !w.isNull) { w.show(); w.zoom = -2; }
         }
      }
   }

   // Show mosaic
   var mosaicWin = ImageWindow.windowById(mosaicId);
   if (mosaicWin && !mosaicWin.isNull) {
      mosaicWin.show();
      mosaicWin.zoom = -2;
   }

   // Apply winner
   si_showApplyWinner(results, sourceId);
}

// =========================================================================
// Main dialog
// =========================================================================
var SIDialog = class extends Dialog {
   constructor() {
      super();
      var self = this;
      this.windowTitle = SCRIPT_TITLE + " v" + SCRIPT_VERSION;
      this.userResizable = false;

      // Header
      var headerLabel = new Label(this);
      headerLabel.text = SCRIPT_TITLE + " v" + SCRIPT_VERSION + "  |  Select a linear image";
      headerLabel.styleSheet = "background:#1a4a1a;color:#88ff88;font-weight:bold;font-size:11px;padding:6px;";
      headerLabel.textAlignment = TextAlignment.Center | TextAlignment.VertCenter;
      headerLabel.setFixedHeight(32);

      // Source image
      var imgLabel = new Label(this);
      imgLabel.text = "Source image:";
      imgLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      imgLabel.setFixedWidth(100);

      var imgCombo = new ComboBox(this);
      var wins = ImageWindow.windows;
      var activeId = (ImageWindow.activeWindow && !ImageWindow.activeWindow.isNull)
         ? ImageWindow.activeWindow.mainView.id : "";
      var activeIdx = 0;
      for (var i=0; i<wins.length; i++) {
         imgCombo.addItem(wins[i].mainView.id);
         if (wins[i].mainView.id === activeId) activeIdx = i;
      }
      imgCombo.currentItem = activeIdx;
      // Always sync sourceId from combo at dialog open — never rely on stale global
      siParams.sourceId = (activeIdx < wins.length) ? wins[activeIdx].mainView.id : "";
      imgCombo.onItemSelected = function(idx) { siParams.sourceId = imgCombo.itemText(idx); };

      var imgRow = new HorizontalSizer;
      imgRow.spacing = 8;
      imgRow.add(imgLabel);
      imgRow.add(imgCombo, 100);

      // Tools group
      var toolGroup = new GroupBox(this);
      toolGroup.title = "Tools to run";
      toolGroup.sizer = new VerticalSizer;
      toolGroup.sizer.margin = 8;
      toolGroup.sizer.spacing = 4;

      function makeToolCheck(label, tip, key) {
         var cb = new CheckBox(self);
         cb.text = label;
         cb.checked = siParams[key];
         cb.toolTip = tip;
         cb.onCheck = function(v) { siParams[key] = v; };
         return cb;
      }

      var htCheck  = makeToolCheck("HT Auto-Stretch",   "HistogramTransformation using STF-derived per-channel midtones. Target background 0.25.", "runHT");
      var masCheck = makeToolCheck("MAS",               "MultiscaleAdaptiveStretch. Target background 0.20, aggressiveness 0.75.", "runMAS");
      var bblCheck = makeToolCheck("Bill Linked (V6)",   "Bill Blanshan linked PixelMath stretch. Single shared MTF from average channel median.", "runBillL");
      var bbuCheck = makeToolCheck("Bill Unlinked (V6)", "Bill Blanshan unlinked PixelMath stretch. Per-channel independent MTF.", "runBillU");
      var ssCheck  = makeToolCheck("Statistical Stretch (Seti Astro)", "Franklin Marek / Seti Astro logarithmic stretch. CC BY-NC 4.0.", "runStatStr");
      var vlCheck  = makeToolCheck("VeraLux HyperMetric", "Riccardo Paterniti inverse-hyperbolic stretch with vector color preservation. GPL-3.0.", "runVeraLux");

      toolGroup.sizer.add(htCheck);
      toolGroup.sizer.add(masCheck);
      toolGroup.sizer.add(bblCheck);
      toolGroup.sizer.add(bbuCheck);
      toolGroup.sizer.add(ssCheck);
      toolGroup.sizer.add(vlCheck);

      // Info label
      var keepWindowsCheck = new CheckBox(this);
      keepWindowsCheck.text = "Keep result windows open after mosaic is built";
      keepWindowsCheck.checked = siParams.keepWindows;
      keepWindowsCheck.toolTip = "When checked, all stretched result windows remain open after the mosaic is built.\n" +
         "Useful for inspecting results at full resolution before deciding which stretch to apply.";
      keepWindowsCheck.onCheck = function(v) { siParams.keepWindows = v; };

      var infoLabel = new Label(this);
      infoLabel.text = "Each tool runs on a fresh clone. Original is never modified.\n" +
         "Working windows are closed after the mosaic is built.";
      infoLabel.styleSheet = "color:#888888;font-size:9px;font-style:italic;";
      infoLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;

      // Buttons
      var runButton = new PushButton(this);
      runButton.text = "Run Inspector";
      runButton.icon = self.scaledResource(":/icons/power.png");
      runButton.onClick = function() { self.ok(); };

      var helpBtn = new PushButton(this);
      helpBtn.text = "Help";
      helpBtn.icon = self.scaledResource(":/icons/help.png");
      helpBtn.toolTip = "Open the help documentation.";
      helpBtn.onClick = function() { si_showHelp(self); };

      var closeButton = new PushButton(this);
      closeButton.text = "Close";
      closeButton.icon = self.scaledResource(":/icons/close.png");
      closeButton.onClick = function() { self.cancel(); };

      var buttonRow = new HorizontalSizer;
      buttonRow.spacing = 8;
      buttonRow.add(runButton);
      buttonRow.addSpacing(4);
      buttonRow.add(helpBtn);
      buttonRow.addStretch();
      buttonRow.add(closeButton);

      // Footer
      var footerLabel = new Label(this);
      footerLabel.text = SCRIPT_TITLE + " v" + SCRIPT_VERSION + "  |  Copyright 2026 Brannon Quel  |  Statistical Stretch: Franklin Marek CC BY-NC 4.0  |  VeraLux: Riccardo Paterniti GPL-3.0";
      footerLabel.styleSheet = "color:#888888;font-size:9px;font-style:italic;";
      footerLabel.textAlignment = TextAlignment.Center | TextAlignment.VertCenter;

      // Main sizer
      this.sizer = new VerticalSizer;
      this.sizer.margin = 10;
      this.sizer.spacing = 8;
      this.sizer.add(headerLabel);
      this.sizer.add(imgRow);
      this.sizer.add(toolGroup);
      this.sizer.add(keepWindowsCheck);
      this.sizer.add(infoLabel);
      this.sizer.add(buttonRow);
      this.sizer.add(footerLabel);
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
   console.show();
   var dlg = new SIDialog();
   if (dlg.execute() === 1) {
      if (!siParams.sourceId) {
         (new MessageBox("No source image selected.", SCRIPT_TITLE, StdIcon.Error, StdButton.Ok)).execute();
         return;
      }
      si_run(siParams.sourceId);
   }
}

main();