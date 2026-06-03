#engine v8

#feature-id    NarrowbandPaletteBlender : PhotonDumpsterFire > NarrowbandPaletteBlender

#feature-icon  NarrowbandPaletteBlender.svg

#feature-info  One-click narrowband palette blending for Ha, OIII, and SII channels.<br/>               Supports SHO, HOO, HSO, OSH, SOH, Foraxx, and Custom palettes.<br/>               Includes normalization, per-channel color masks, SCNR, tone adjustment,<br/>               synthetic luminance, magenta reduction, and star recombination.<br/>               <br/>               Written by Brannon Quel<br/>               Copyright &copy; 2026 Brannon Quel

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

// ╔══════════════════════════════════════════════╗
// ║                                              ║
// ║      _   _   ____   ____                     ║
// ║     | \ | | |  _ \ |  _ \                    ║
// ║     |  \| | | |_) || |_) |                   ║
// ║     | .\ | |  __/ |  _ <                     ║
// ║     | | \ | | |    | |_) |                   ║
// ║     |_|  \_||_|    |____/                    ║
// ║                                              ║
// ║          Narrowband Palette Blender          ║
// ║    v1.0  |  Author: Brannon Quel  |  2025    ║
// ║                                              ║
// ╚══════════════════════════════════════════════╝
//
// NarrowbandPaletteBlender.js
// Copyright (C) 2025 Brannon Quel
//
// A PixInsight script for combining Ha, OIII, and SII narrowband stacks
// into color images using a variety of palette modes including SHO, HOO,
// HSO, OSH, SOH, Foraxx, and custom PixelMath expressions.
//
// Before using this script, each channel image should be:
//   - Registered and cropped to the same frame
//   - Gradient corrected
//   - Starless (recommended)
//   - Stretched to non-linear (histogram transformed)
//
// Features:
//   - One-click Auto mode — analyzes channel data and sets palette-aware
//     boost, normalization, SCNR, masking, and magenta reduction
//   - Eight palette modes with palette-aware channel mapping
//   - Masked channel boosts — boost only where target color exists,
//     protecting black backgrounds and unrelated color regions
//   - Normalization with median/mean and configurable scale cap
//   - SCNR green reduction and magenta reduction (invert/SCNR/invert)
//   - Synthetic luminance replacement
//   - Tone adjustment (shadows, midpoint, highlights)
//   - Recipe logging to console for reproducible results
//
// Version history:
//   1.0  2025-xx-xx  Initial public release
//   1.1  2025-xx-xx  Inline mask preview, HOO normalization cleanup, Help button
//   1.2  2025-xx-xx  Three-column layout, window cleanup, real-time Reset Defaults
//   1.0   2026        Final release. V8 engine port: removed #include pjsr headers, updated constants,
//              rewrote Dialog as class expression extending Dialog with super()
//
// ============================================================


// -------------------------------------------------------------------------
// Global constants
// -------------------------------------------------------------------------
var SCRIPT_VERSION  = "1.0";
var SCRIPT_TITLE    = "Narrowband Palette Blender";
var PREVIEW_WORK_ID = "_sho_preview_work";
var LEFT_COL_W      = 340;   // reverted — was over-wide in 2.0/2.1
var PREVIEW_MIN_W   = 650;
var PREVIEW_MIN_H   = 450;

// -------------------------------------------------------------------------
// Default parameters
// -------------------------------------------------------------------------
var DEFAULT_PARAMS = {
   haImageId:          "",
   oiiiImageId:        "",
   siiImageId:         "",

   paletteMode:        0,     // 0=SHO, 1=HOO, 2=HSO, 3=OSH, 4=SOH, 5=Foraxx static, 6=Foraxx dynamic, 7=Custom

   // Tone adjustment (applied after SCNR, before output)
   // HistogramTransformation: shadows=black point, midpoint=gamma, highlights=white point
   applyTone:          false,
   toneShadows:        0.0,   // 0.0 = no black point clip
   toneMidpoint:       0.5,   // PI native MTF midpoint: 0.5=neutral, <0.5=brighter, >0.5=darker
   toneHighlights:     1.0,   // 1.0 = no white point clip

   // Per-channel adjustments: 0 = no change, range -1.0 to +1.0
   // Effective multiplier = 1.0 + value
   haAdjust:           0.0,
   oiiiAdjust:         0.0,
   siiAdjust:          0.0,

   // Per-channel color masks — applied during boost/suppress
   // Mask is built from image hue/chrominance, blurred, then used to spatially
   // limit the channel adjustment so only masked regions are boosted
   // Color: 0=Red, 1=Yellow, 2=Green, 3=Cyan, 4=Blue, 5=Magenta
   haMaskEnabled:      false,
   haMaskColor:        0,
   haMaskStrength:     1.0,
   haMaskBlurPasses:   1,
   haMaskBlurSigma:    7.0,

   oiiiMaskEnabled:    false,
   oiiiMaskColor:      4,     // Blue default for OIII
   oiiiMaskStrength:   1.0,
   oiiiMaskBlurPasses: 1,
   oiiiMaskBlurSigma:  7.0,

   siiMaskEnabled:     false,
   siiMaskColor:       0,     // Red default for SII
   siiMaskStrength:    1.0,
   siiMaskBlurPasses:  1,
   siiMaskBlurSigma:   7.0,

   // Normalization
   normalizeChannels:  true,
   normalizationMode:  0,     // 0=Median, 1=Mean
   normScaleCap:       2.0,   // max multiplier applied to OIII and SII during normalization
                               // 1.0 = no scaling allowed, 5.0 = effectively uncapped

   // Foraxx blend weights
   foraxx_R_SII:       0.80,
   foraxx_R_Ha:        0.20,
   foraxx_G_Ha:        0.80,
   foraxx_G_OIII:      0.20,
   foraxx_B_OIII:      1.00,
   foraxx_B_Ha:        0.00,

   // Custom PixelMath expressions
   custom_R_expr:      "SII",
   custom_G_expr:      "Ha",
   custom_B_expr:      "OIII",

   // Stretch — off by default, most users pre-stretch
   // Star recombination — screen blend, absolute last step
   applyStars:         false,
   starsImageId:       "",
   // Settings match manual workflow: Average Neutral, amount 1.0
   applyMagentaReduction:  false,
   magentaAmount:          0.5,
   magentaMethod:          2,   // Average Neutral

   scnrAmount:         0.20,
   scnrMethod:         2,   // Average Neutral

   // Synthetic luminance via Rec.709 luma scaling
   // Scales RGB channels proportionally to match the new luminance source
   applyLuminance:     false,
   lumMode:            1,     // 0=Ha, 1=SII, 2=OIII, 3=Weighted blend
   lumStrength:        0.5,   // 0.0=no change, 1.0=full L replacement
   lumHaWeight:        0.50,
   lumSiiWeight:       0.40,
   lumOiiiWeight:      0.10,

   // Preview
   previewScale:       4,
   previewApplySCNR:   true,

   // Output
   outputId:           "_Blended",
   closeIntermediates: true
};

var params = {};
for ( var k in DEFAULT_PARAMS ) params[k] = DEFAULT_PARAMS[k];

// Preview state
var previewPanelW = 600;
var previewPanelH = 450;

// -------------------------------------------------------------------------
// Utility
// -------------------------------------------------------------------------
function getGrayscaleImageIds() {
   var ids = [], wins = ImageWindow.windows;
   for ( var i = 0; i < wins.length; i++ )
      if ( wins[i].mainView.image.numberOfChannels == 1 )
         ids.push( wins[i].mainView.id );
   return ids;
}

function windowById( id ) {
   var wins = ImageWindow.windows;
   for ( var i = 0; i < wins.length; i++ )
      if ( wins[i].mainView.id == id )
         return wins[i];
   return null;
}

function closeWindowById( id ) {
   var w = windowById( id );
   if ( w ) w.forceClose();
}

function imageMedian( view ) { return view.image.median(); }
function imageMean( view )   { return view.image.mean();   }

// -------------------------------------------------------------------------
// Duplicate image
// hideWindow: pass true during preview to suppress screen flicker
// -------------------------------------------------------------------------
function duplicateImage( srcWin, newId, hideWindow ) {
   closeWindowById( newId );
   var si = srcWin.mainView.image;
   var nw = new ImageWindow( si.width, si.height, 1,
                             si.bitsPerSample, si.isReal, false, newId );
   nw.mainView.beginProcess( UndoFlag.NoSwapFile );
   nw.mainView.image.assign( si );
   nw.mainView.endProcess();
   if ( !hideWindow ) nw.show();
   return nw;
}

// -------------------------------------------------------------------------
// Downsample for preview
// hideWindow: pass true during preview to suppress screen flicker
// -------------------------------------------------------------------------
function downsampleImage( srcWin, newId, factor, hideWindow ) {
   closeWindowById( newId );
   var si = srcWin.mainView.image;
   var nw = new ImageWindow( si.width, si.height, 1,
                             si.bitsPerSample, si.isReal, false, newId );
   nw.mainView.beginProcess( UndoFlag.NoSwapFile );
   nw.mainView.image.assign( si );
   nw.mainView.endProcess();
   if ( !hideWindow ) nw.show();
   var ir = new IntegerResample;
   ir.zoomFactor       = -factor;
   ir.downsamplingMode = IntegerResample.Average;
   ir.executeOn( nw.mainView );
   return nw;
}

// -------------------------------------------------------------------------
// Scale image by multiplier
// -------------------------------------------------------------------------
function scaleImage( view, factor ) {
   var f = Math.max( 0, factor );
   var pm = new PixelMath;
   pm.expression          = "range($T * " + f.toFixed(8) + ", 0, 1)";
   pm.useSingleExpression = true;
   pm.generateOutput      = true;
   pm.createNewImage      = false;
   pm.executeOn( view );
}

// -------------------------------------------------------------------------
// Normalize OIII and SII to match Ha, with scale cap
// Cap prevents weak channels from being boosted beyond normScaleCap multiplier
// -------------------------------------------------------------------------
function normalizeChannels( haView, oiiiView, siiView ) {
   var isHOO = ( params.paletteMode == 1 );

   var haRef, ov, sv;
   if ( params.normalizationMode == 0 ) {
      haRef = imageMedian( haView );
      ov    = imageMedian( oiiiView );
      sv    = isHOO ? 0 : imageMedian( siiView );
   } else {
      haRef = imageMean( haView );
      ov    = imageMean( oiiiView );
      sv    = isHOO ? 0 : imageMean( siiView );
   }

   var oiiiScale = ( ov > 0 ) ? haRef / ov : 1.0;
   var siiScale  = ( !isHOO && sv > 0 ) ? haRef / sv : 1.0;

   var cap = params.normScaleCap;
   var oiiiScaleCapped = Math.min( oiiiScale, cap );
   var siiScaleCapped  = Math.min( siiScale,  cap );

   console.writeln( "  Ha ref:  " + haRef.toFixed(6) +
                    "  OIII: "    + ov.toFixed(6) +
                    ( isHOO ? "  SII: (not used in HOO)" :
                      "  SII: " + sv.toFixed(6) ) );
   console.writeln( "  OIII scale: " + oiiiScale.toFixed(3) +
                    ( oiiiScale > cap ? "  → capped at " + oiiiScaleCapped.toFixed(3) : "" ) );
   if ( !isHOO )
      console.writeln( "  SII scale:  " + siiScale.toFixed(3) +
                       ( siiScale > cap ? "  → capped at " + siiScaleCapped.toFixed(3) : "" ) );

   if ( ov > 0 ) scaleImage( oiiiView, oiiiScaleCapped );
   if ( !isHOO && sv > 0 ) scaleImage( siiView, siiScaleCapped );
}

// -------------------------------------------------------------------------
// Color mask expressions — your exact PixelMath expressions with S substituted
// targetView is used as the source for H() and CIEc() hue/chrominance
// -------------------------------------------------------------------------
var COLOR_MASK_EXPRESSIONS = [
   // 0 = Red
   "iif(H($T)<=0,~mtf((H($T)+1-(5/6))/(1/6),~S)*CIEc($T),iif(H($T)<=(1/6),~mtf(((1/6)-H($T))/(1/6),~S)*CIEc($T),iif(H($T)<(5/6),0,~mtf((H($T)-(5/6))/(1/6),~S)*CIEc($T))))",
   // 1 = Yellow
   "iif(H($T)<0,0,iif(H($T)<=(1/6),~mtf((H($T)-0)/(1/6),~S)*CIEc($T),iif(H($T)<=(1/3),~mtf(((1/3)-H($T))/(1/6),~S)*CIEc($T),0)))",
   // 2 = Green
   "iif(H($T)<(1/6),0,iif(H($T)<=(1/3),~mtf((H($T)-(1/6))/(1/6),~S)*CIEc($T),iif(H($T)<=(3/6),~mtf(((3/6)-H($T))/(1/6),~S)*CIEc($T),0)))",
   // 3 = Cyan
   "iif(H($T)<(1/3),0,iif(H($T)<=(3/6),~mtf((H($T)-(1/3))/(1/6),~S)*CIEc($T),iif(H($T)<=(2/3),~mtf(((2/3)-H($T))/(1/6),~S)*CIEc($T),0)))",
   // 4 = Blue
   "iif(H($T)<(1/3),0,iif(H($T)<=(4/6),~mtf((H($T)-(3/6))/(1/6),~S)*CIEc($T),iif(H($T)<=(5/6),~mtf(((5/6)-H($T))/(1/6),~S)*CIEc($T),0)))",
   // 5 = Magenta
   "iif(H($T)<=0,~mtf((0-H($T))/(1/6),~S)*CIEc($T),iif(H($T)<(2/3),0,iif(H($T)<=(5/6),~mtf((H($T)-(2/3))/(1/6),~S)*CIEc($T),~mtf((1+0-H($T))/(1/6),~S)*CIEc($T))))"
];

var COLOR_MASK_NAMES = ["Red","Yellow","Green","Cyan","Blue","Magenta"];

// Build a color mask for a given view, blur it N times, return mask window ID
// Caller must close the mask window when done
function buildColorMask( sourceView, colorIdx, strength, blurPasses, blurSigma, maskId ) {
   closeWindowById( maskId );

   // Substitute S and ~S directly into the expression
   // PI PixelMath does not support S=value; variable assignment in scripted mode
   var sVal    = strength.toFixed(6);
   var notSVal = (1.0 - strength).toFixed(6);   // ~S = 1 - S in normalized [0,1]

   var expr = COLOR_MASK_EXPRESSIONS[colorIdx];
   // Replace ~S with the complement value and S with the literal
   // Order matters: replace ~S first, then bare S
   expr = expr.replace(/~S/g, notSVal);
   expr = expr.replace(/\bS\b/g, sVal);

   var pm = new PixelMath;
   pm.expression          = expr;
   pm.useSingleExpression = true;
   pm.generateOutput      = true;
   pm.createNewImage      = true;
   pm.newImageId           = maskId;
   pm.newImageWidth        = 0;
   pm.newImageHeight       = 0;
   pm.newImageColorSpace   = PixelMath.Gray;
   pm.newImageSampleFormat = PixelMath.SameAsTarget;
   pm.executeOn( sourceView );

   var maskWin = windowById( maskId );
   if ( !maskWin ) {
      console.writeln( "  Warning: color mask build failed for " + COLOR_MASK_NAMES[colorIdx] );
      return null;
   }
   maskWin.hide();

   // Normalize mask to 0-1 range so boost slider has full effect
   // Without this, low chrominance in narrowband images keeps mask values
   // very low (0.1-0.3) making the boost slider nearly invisible
   if ( blurPasses > 0 && blurSigma > 0 ) {
      var blurPm = new PixelMath;
      blurPm.expression          = "gconv($T," + blurSigma.toFixed(1) + ",1,0)";
      blurPm.useSingleExpression = true;
      blurPm.generateOutput      = true;
      blurPm.createNewImage      = false;
      for ( var i = 0; i < blurPasses; i++ )
         blurPm.executeOn( maskWin.mainView );
   }

   // Normalize: stretch mask so peak = 1.0
   var maskImg = maskWin.mainView.image;
   maskImg.selectedChannel = 0;
   var maskMax = maskImg.maximum();
   maskImg.resetSelections();
   if ( maskMax > 0.001 ) {
      var normPm = new PixelMath;
      normPm.expression          = "$T / " + maskMax.toFixed(6);
      normPm.useSingleExpression = true;
      normPm.generateOutput      = true;
      normPm.createNewImage      = false;
      normPm.executeOn( maskWin.mainView );
   }

   return maskWin;
}

// -------------------------------------------------------------------------
// Palette channel mapping
// Returns which RGB output channels (0=R,1=G,2=B) each source drives
// for the active palette. Used to make masked boosts channel-specific.
// Foraxx (static/dynamic) and Custom return all three — RGB-wide behavior
// since source contributions are blended and not one-to-one.
// -------------------------------------------------------------------------
function getPaletteChannelMap() {
   // Returns {ha:[channels], oiii:[channels], sii:[channels]}
   switch ( params.paletteMode ) {
      case 0: // SHO: SII=R, Ha=G, OIII=B
         return { ha:[1], oiii:[2], sii:[0] };
      case 1: // HOO: Ha=R, OIII=G+B
         return { ha:[0], oiii:[1,2], sii:[] };
      case 2: // HSO: Ha=R, SII=G, OIII=B
         return { ha:[0], oiii:[2], sii:[1] };
      case 3: // OSH: OIII=R, SII=G, Ha=B
         return { ha:[2], oiii:[0], sii:[1] };
      case 4: // SOH: SII=R, OIII=G, Ha=B
         return { ha:[2], oiii:[1], sii:[0] };
      default: // Foraxx static/dynamic/Custom — blended, use RGB-wide
         return { ha:[0,1,2], oiii:[0,1,2], sii:[0,1,2] };
   }
}

// Apply a masked channel adjustment targeting only specific RGB output channels
// channels: array of channel indices to adjust (e.g. [2] for blue only)
// If channels is empty or contains all three, falls back to RGB-wide boost
function applyMaskedChannelAdjust( view, adjustment, maskWin, channels ) {
   if ( Math.abs( adjustment ) < 0.001 ) return;

   if ( !maskWin ) {
      scaleImage( view, 1.0 + adjustment );
      return;
   }

   var mId = maskWin.mainView.id;
   var vId = view.id;
   var adj = adjustment.toFixed(6);

   // Check if we need channel-specific or RGB-wide
   var isRGBWide = ( !channels || channels.length == 0 || channels.length == 3 );

   if ( isRGBWide ) {
      // RGB-wide: scale all channels equally (Foraxx/Custom palettes)
      var pm = new PixelMath;
      pm.expression =
         "range($T * (1 + " + adj + " * " + mId + "), 0, 1)";
      pm.useSingleExpression = true;
      pm.generateOutput      = true;
      pm.createNewImage      = false;
      pm.executeOn( view );
      console.writeln( "    RGB-wide boost: adj=" + adj );
   } else {
      // Channel-specific: only modify targeted channels
      // Use multi-expression PixelMath — untargeted channels pass through unchanged
      var exprs = [
         vId + "[0]",   // R passthrough by default
         vId + "[1]",   // G passthrough by default
         vId + "[2]"    // B passthrough by default
      ];
      for ( var i = 0; i < channels.length; i++ ) {
         var c = channels[i];
         exprs[c] =
            "range(" + vId + "[" + c + "] * (1 + " + adj + " * " + mId + "), 0, 1)";
      }
      var pm = new PixelMath;
      pm.expression  = exprs[0];
      pm.expression1 = exprs[1];
      pm.expression2 = exprs[2];
      pm.useSingleExpression = false;
      pm.generateOutput      = true;
      pm.createNewImage      = false;
      pm.executeOn( view );
      var chNames = ["R","G","B"];
      var targeted = channels.map( function(c){ return chNames[c]; } ).join("+");
      console.writeln( "    Channel-specific boost: ch=" + targeted + "  adj=" + adj );
   }
}

// -------------------------------------------------------------------------
// Per-channel boost/suppress with optional color masks
// -------------------------------------------------------------------------
function applyChannelAdjustments( haView, oiiiView, siiView ) {
   // When a mask is enabled for a channel, skip the global boost here.
   // The boost will run post-combination in applyColorMaskedBoosts,
   // spatially limited to the masked region only — not applied globally.
   // This means the boost only affects areas where the target color exists,
   // protecting black backgrounds and other color regions.

   if ( Math.abs( params.haAdjust ) > 0.001 ) {
      if ( params.haMaskEnabled ) {
         console.writeln( "  Ha adjust:   deferred to masked boost" );
      } else {
         console.writeln( "  Ha adjust:   x" + (1+params.haAdjust).toFixed(3) );
         scaleImage( haView, 1.0 + params.haAdjust );
      }
   }
   if ( Math.abs( params.oiiiAdjust ) > 0.001 ) {
      if ( params.oiiiMaskEnabled ) {
         console.writeln( "  OIII adjust: deferred to masked boost" );
      } else {
         console.writeln( "  OIII adjust: x" + (1+params.oiiiAdjust).toFixed(3) );
         scaleImage( oiiiView, 1.0 + params.oiiiAdjust );
      }
   }
   if ( Math.abs( params.siiAdjust ) > 0.001 ) {
      if ( params.siiMaskEnabled ) {
         console.writeln( "  SII adjust:  deferred to masked boost" );
      } else {
         console.writeln( "  SII adjust:  x" + (1+params.siiAdjust).toFixed(3) );
         scaleImage( siiView, 1.0 + params.siiAdjust );
      }
   }
}

// -------------------------------------------------------------------------
// Apply color-masked channel boosts to the combined RGB image
// Called after combination so we have a color image for hue-based masking
// -------------------------------------------------------------------------
function applyColorMaskedBoosts( combinedWin ) {
   var cView = combinedWin.mainView;
   var chMap = getPaletteChannelMap();

   // Ha boost with optional mask
   if ( Math.abs( params.haAdjust ) > 0.001 ) {
      var haMask = null;
      if ( params.haMaskEnabled ) {
         console.writeln( "  Ha color mask: " + COLOR_MASK_NAMES[params.haMaskColor] +
            "  channels=" + chMap.ha.join(",") );
         haMask = buildColorMask( cView, params.haMaskColor,
            params.haMaskStrength, params.haMaskBlurPasses,
            params.haMaskBlurSigma, "_sho_mask_ha" );
      }
      if ( haMask ) {
         applyMaskedChannelAdjust( cView, params.haAdjust, haMask, chMap.ha );
         haMask.forceClose();
      }
   }

   // OIII boost with optional mask
   if ( Math.abs( params.oiiiAdjust ) > 0.001 ) {
      var oiiiMask = null;
      if ( params.oiiiMaskEnabled ) {
         console.writeln( "  OIII color mask: " + COLOR_MASK_NAMES[params.oiiiMaskColor] +
            "  channels=" + chMap.oiii.join(",") );
         oiiiMask = buildColorMask( cView, params.oiiiMaskColor,
            params.oiiiMaskStrength, params.oiiiMaskBlurPasses,
            params.oiiiMaskBlurSigma, "_sho_mask_oiii" );
      }
      if ( oiiiMask ) {
         applyMaskedChannelAdjust( cView, params.oiiiAdjust, oiiiMask, chMap.oiii );
         oiiiMask.forceClose();
      }
   }

   // SII boost with optional mask
   if ( Math.abs( params.siiAdjust ) > 0.001 ) {
      var siiMask = null;
      if ( params.siiMaskEnabled ) {
         console.writeln( "  SII color mask: " + COLOR_MASK_NAMES[params.siiMaskColor] +
            "  channels=" + chMap.sii.join(",") );
         siiMask = buildColorMask( cView, params.siiMaskColor,
            params.siiMaskStrength, params.siiMaskBlurPasses,
            params.siiMaskBlurSigma, "_sho_mask_sii" );
      }
      if ( siiMask ) {
         applyMaskedChannelAdjust( cView, params.siiAdjust, siiMask, chMap.sii );
         siiMask.forceClose();
      }
   }
}

// -------------------------------------------------------------------------
// Palette expressions
// -------------------------------------------------------------------------
function paletteName() {
   return ["SHO", "HOO", "HSO", "OSH", "SOH",
           "Foraxx (static)", "Foraxx (dynamic)", "Custom"][params.paletteMode] || "Unknown";
}

// True dynamic Foraxx expressions from thecoldestnights.com (ForaxX#0335)
// R: SII where OIII is strong, Ha where OIII is weak
// G: Ha where both Ha+OIII are strong, OIII where either is weak
// B: pure OIII
var FORAXX_DYN_R = "(OIII^~OIII)*SII + ~(OIII^~OIII)*Ha";
var FORAXX_DYN_G = "((OIII*Ha)^~(OIII*Ha))*Ha + ~((OIII*Ha)^~(OIII*Ha))*OIII";
var FORAXX_DYN_B = "OIII";

function buildExpressions( haId, oiiiId, siiId ) {
   var R, G, B;

   // helper to substitute token names with actual image IDs
   var sub = function(s) {
      return s.replace(/Ha/g,   haId)
              .replace(/OIII/g, oiiiId)
              .replace(/SII/g,  siiId);
   };

   switch ( params.paletteMode ) {
      case 0: // SHO
         R = siiId;  G = haId;   B = oiiiId; break;
      case 1: // HOO
         R = haId;   G = oiiiId; B = oiiiId; break;
      case 2: // HSO
         R = haId;   G = siiId;  B = oiiiId; break;
      case 3: // OSH
         R = oiiiId; G = siiId;  B = haId;   break;
      case 4: // SOH
         R = siiId;  G = oiiiId; B = haId;   break;
      case 5: // Foraxx static weighted blend
         R = "(" + params.foraxx_R_SII.toFixed(4)  + "*" + siiId  + "+" +
                   params.foraxx_R_Ha.toFixed(4)    + "*" + haId   + ")";
         G = "(" + params.foraxx_G_Ha.toFixed(4)    + "*" + haId   + "+" +
                   params.foraxx_G_OIII.toFixed(4)  + "*" + oiiiId + ")";
         B = "(" + params.foraxx_B_OIII.toFixed(4)  + "*" + oiiiId + "+" +
                   params.foraxx_B_Ha.toFixed(4)    + "*" + haId   + ")";
         break;
      case 6: // Foraxx dynamic — true per-pixel blend
         R = sub( FORAXX_DYN_R );
         G = sub( FORAXX_DYN_G );
         B = sub( FORAXX_DYN_B );
         break;
      case 7: // Custom
         R = sub( params.custom_R_expr );
         G = sub( params.custom_G_expr );
         B = sub( params.custom_B_expr );
         break;
      default: R = siiId; G = haId; B = oiiiId;
   }
   return {
      R: "range(" + R + ",0,1)",
      G: "range(" + G + ",0,1)",
      B: "range(" + B + ",0,1)"
   };
}

// -------------------------------------------------------------------------
// Combine channels
// -------------------------------------------------------------------------
function combineChannels( haView, oiiiView, siiView, outId ) {
   var expr = buildExpressions( haView.id, oiiiView.id, siiView.id );
   console.writeln( "  R: " + expr.R );
   console.writeln( "  G: " + expr.G );
   console.writeln( "  B: " + expr.B );
   closeWindowById( outId );
   var pm = new PixelMath;
   pm.expression           = expr.R;
   pm.expression1          = expr.G;
   pm.expression2          = expr.B;
   pm.expression3          = "";
   pm.useSingleExpression  = false;
   pm.generateOutput       = true;
   pm.createNewImage       = true;
   pm.newImageId           = outId;
   pm.newImageWidth        = 0;
   pm.newImageHeight       = 0;
   pm.newImageColorSpace   = PixelMath.RGB;
   pm.newImageSampleFormat = PixelMath.SameAsTarget;
   pm.executeOn( haView );
   var w = windowById( outId );
   if ( !w ) throw new Error( "PixelMath combination failed." );
   return w;
}

// -------------------------------------------------------------------------
// Synthetic luminance via ChannelCombination in CIE L*a*b* color space
// Replaces ONLY the L channel of the combined color image.
// a and b channels (color) are preserved untouched.
// Sources come from the normalized+adjusted working clones.
// -------------------------------------------------------------------------
function buildLuminanceSource( combinedView, suffix ) {
   var lumId = "_sho_lum" + suffix;
   closeWindowById( lumId );

   // Use the original assigned images directly (not the normalized pipeline clones)
   // so the luminance reflects the user's fully processed source data
   var haId   = params.haImageId;
   var oiiiId = params.oiiiImageId;
   var siiId  = params.siiImageId;

   var lumExpr;
   switch ( params.lumMode ) {
      case 0: // Ha
         lumExpr = haId;
         console.writeln( "  Luminance source: Ha (original)" );
         break;
      case 1: // SII
         lumExpr = siiId;
         console.writeln( "  Luminance source: SII (original)" );
         break;
      case 2: // OIII
         lumExpr = oiiiId;
         console.writeln( "  Luminance source: OIII (original)" );
         break;
      case 3: // Weighted blend of originals
         var hw = params.lumHaWeight;
         var sw = params.lumSiiWeight;
         var ow = params.lumOiiiWeight;
         var total = hw + sw + ow;
         if ( total < 0.001 ) { hw = 1; sw = 0; ow = 0; total = 1; }
         lumExpr =
            "range(" +
            (hw/total).toFixed(4) + "*" + haId   + "+" +
            (sw/total).toFixed(4) + "*" + siiId  + "+" +
            (ow/total).toFixed(4) + "*" + oiiiId +
            ",0,1)";
         console.writeln( "  Luminance: Ha=" + (hw/total).toFixed(3) +
                          "  SII=" + (sw/total).toFixed(3) +
                          "  OIII=" + (ow/total).toFixed(3) + " (originals)" );
         break;
      default:
         lumExpr = siiId;
   }

   // Build the luminance image via PixelMath
   // Execute on the combined view so image IDs resolve correctly
   var pm = new PixelMath;
   pm.expression           = "range(" + lumExpr + ",0,1)";
   pm.useSingleExpression  = true;
   pm.generateOutput       = true;
   pm.createNewImage       = true;
   pm.newImageId           = lumId;
   pm.newImageWidth        = 0;
   pm.newImageHeight       = 0;
   pm.newImageColorSpace   = PixelMath.Gray;
   pm.newImageSampleFormat = PixelMath.SameAsTarget;
   pm.executeOn( combinedView );

   var lumWin = windowById( lumId );
   if ( !lumWin ) throw new Error( "Luminance build failed." );
   lumWin.hide();   // always hide — never needs to be visible
   return lumWin;
}

function applyLuminance( colorWin, lumWin ) {
   // Replace luminance while preserving color (hue/saturation)
   // Method: scale RGB by (newL / oldL) where oldL = Rec.709 luma
   // oldL = 0.2126*R + 0.7152*G + 0.0722*B
   // This is pure PixelMath arithmetic — no unknown function names
   var cId  = colorWin.mainView.id;
   var lId  = lumWin.mainView.id;

   // Build oldL as a new grayscale image via PixelMath
   var oldLId = "_sho_oldL";
   closeWindowById( oldLId );
   var pm1 = new PixelMath;
   pm1.expression =
      "range(0.2126*" + cId + "[0] + 0.7152*" + cId + "[1] + 0.0722*" + cId + "[2],0,1)";
   pm1.useSingleExpression  = true;
   pm1.generateOutput       = true;
   pm1.createNewImage       = true;
   pm1.newImageId           = oldLId;
   pm1.newImageWidth        = 0;
   pm1.newImageHeight       = 0;
   pm1.newImageColorSpace   = PixelMath.Gray;
   pm1.newImageSampleFormat = PixelMath.SameAsTarget;
   pm1.executeOn( colorWin.mainView );

   var oldLWin = windowById( oldLId );
   if ( !oldLWin ) {
      lumWin.forceClose();
      throw new Error( "Luminance: failed to build oldL image." );
   }
   oldLWin.hide();

   // Blend by strength: 1.0=full replacement, 0.0=no change
   // Formula: $T * (1 + strength * (newL/oldL - 1))
   // At strength=1: $T * (newL/oldL) — full replacement
   // At strength=0: $T * 1 — no change
   var s = Math.max( 0.0, Math.min( 1.0, params.lumStrength ) );
   var pm2 = new PixelMath;
   pm2.expression =
      "iif(" + oldLId + " > 0.001, " +
         "range($T * (1 + " + s.toFixed(6) +
         " * (" + lId + " / " + oldLId + " - 1)), 0, 1), " +
         "$T)";
   pm2.useSingleExpression = true;
   pm2.generateOutput      = true;
   pm2.createNewImage      = false;
   pm2.executeOn( colorWin.mainView );

   oldLWin.forceClose();
   lumWin.forceClose();
}

// -------------------------------------------------------------------------
// Stretch
// -------------------------------------------------------------------------
function computeHTChannels( img, targetBg ) {
   var channels = [], ch;
   for ( ch = 0; ch < 3; ch++ ) {
      img.selectedChannel = ch;
      var med = img.median();
      var mad = img.MAD();
      if ( mad == 0 ) mad = 1e-6;
      var c0  = Math.max( 0, med - 2.8 * 1.4826 * mad );
      var mp  = med - c0;
      if ( mp <= 0 ) mp = 1e-6;
      var mid = ((targetBg - 1) * mp) / ((2 * targetBg - 1) * mp - targetBg);
      mid = Math.max( 0.001, Math.min( 0.999, mid ) );
      channels.push( [mid, 0, 1, 0, 1] );
   }
   img.resetSelections();
   channels.push( [0.5, 0, 1, 0, 1] );
   return channels;
}

function applySTFToScreen( win ) {
   var img = win.mainView.image;
   var stfs = [], ch;
   for ( ch = 0; ch < 3; ch++ ) {
      img.selectedChannel = ch;
      var med = img.median();
      var mad = img.MAD();
      if ( mad == 0 ) mad = 1e-6;
      var c0  = Math.max( 0, med - 2.8 * 1.4826 * mad );
      var mp  = med - c0;
      if ( mp <= 0 ) mp = 1e-6;
      var mid = ((0.25 - 1) * mp) / ((2 * 0.25 - 1) * mp - 0.25);
      mid = Math.max( 0.001, Math.min( 0.999, mid ) );
      stfs.push( [c0, 1.0, mid, 0, 1] );
   }
   img.resetSelections();
   stfs.push( [0, 1, 0.5, 0, 1] );
   var stf = new ScreenTransferFunction;
   stf.STF = stfs;
   stf.executeOn( win.mainView );
}

// -------------------------------------------------------------------------
// Magenta reduction — invert / SCNR green / invert
// Runs as the absolute last step in the pipeline, after green SCNR,
// tone adjustment, and luminance. At this point green SCNR is already
// done so there is no interference between the two passes.
// -------------------------------------------------------------------------
function applyMagentaReduction( win ) {
   var inv = new Invert;
   inv.executeOn( win.mainView );

   var scnr = new SCNR;
   scnr.amount            = params.magentaAmount;
   scnr.protectionMethod  = params.magentaMethod;
   scnr.colorToRemove     = SCNR.Green;
   scnr.preserveLightness = true;
   scnr.executeOn( win.mainView );

   inv.executeOn( win.mainView );
   console.writeln( "  Magenta reduction: amount=" + params.magentaAmount.toFixed(2) );
}


// -------------------------------------------------------------------------
// Hue / Saturation — targets a single hue range via ColorSaturation
// Optionally masked so boost only applies where target color exists
// Sits between tone adjustment and luminance in the pipeline
// -------------------------------------------------------------------------
// Star recombination — screen blend ~(~starless * ~stars)
// Runs as absolute last step after magenta reduction
// Works with RGB or grayscale star images
// -------------------------------------------------------------------------
function applyStarRecombination( combinedWin ) {
   if ( !params.applyStars ) return;
   if ( params.starsImageId == "" ) return;

   var starsWin = windowById( params.starsImageId );
   if ( !starsWin ) {
      console.warningln( "  Star recombination: image not found — " + params.starsImageId );
      return;
   }

   var pm = new PixelMath;
   pm.expression          = "~(~$T*~" + params.starsImageId + ")";
   pm.useSingleExpression = true;
   pm.generateOutput      = true;
   pm.createNewImage      = false;
   pm.executeOn( combinedWin.mainView );

   console.writeln( "  Stars added: " + params.starsImageId + "  (~(~starless * ~stars))" );
}

// -------------------------------------------------------------------------
// ------------------------------------------------------------------------- — builds and displays the mask for a given channel
// Requires a preview to have been run first for the combined image
// -------------------------------------------------------------------------
function showMaskPreview( channel ) {
   var colorKey    = channel + "MaskColor";
   var strengthKey = channel + "MaskStrength";
   var blurKey     = channel + "MaskBlurPasses";
   var sigmaKey    = channel + "MaskBlurSigma";

   var combinedWin = windowById( PREVIEW_WORK_ID );
   if ( !combinedWin ) {
      (new MessageBox(
         "Please run Preview / Refresh first.\n" +
         "The mask is built from the combined color image.",
         SCRIPT_TITLE, StdIcon.Information, StdButton.Ok
      )).execute();
      return;
   }

   var maskId = "_npb_mask_" + channel;
   closeWindowById( maskId );

   var maskWin = buildColorMask(
      combinedWin.mainView,
      params[colorKey],
      params[strengthKey],
      params[blurKey],
      params[sigmaKey],
      maskId
   );

   if ( maskWin ) {
      maskWin.show();
      maskWin.zoomToFit();
      console.writeln( "  Mask preview: " + channel.toUpperCase() +
         " — " + COLOR_MASK_NAMES[params[colorKey]] +
         "  Close the mask window when finished adjusting." );
      Console.show();
   }
}

// ------------------------------------------------------------------------- — shadows, midpoint (gamma), highlights
// Applied via HistogramTransformation to all RGB channels equally
// -------------------------------------------------------------------------
function applyToneAdjustment( win ) {
   if ( !params.applyTone ) return;

   var s  = params.toneShadows;
   var m  = params.toneMidpoint;
   var h  = params.toneHighlights;

   // Strict guard — don't run if effectively neutral
   if ( Math.abs( s ) < 0.0001 &&
        Math.abs( m - 0.5 ) < 0.0001 &&
        Math.abs( h - 1.0 ) < 0.0001 ) return;

   // Clamp to valid ranges
   s = Math.max( 0.0, Math.min( 0.99, s ) );
   h = Math.max( s + 0.001, Math.min( 1.0, h ) );
   m = Math.max( 0.001, Math.min( 0.999, m ) );

   // Use CurvesTransformation instead of HistogramTransformation
   // CurvesTransformation is simpler and more predictable from PJSR
   // Shadows: lift black point by adding a floor
   // Highlights: compress by capping the ceiling
   // Midpoint: apply a power curve (gamma)
   // We implement this via PixelMath which is reliable and well-tested
   var pm = new PixelMath;
   // Formula: rescale from [s,h] to [0,1], then apply midtone power
   // power = log(0.5) / log(m) converts PI midpoint to gamma
   var gamma = Math.log( 0.5 ) / Math.log( m );
   gamma = Math.max( 0.1, Math.min( 10.0, gamma ) );
   pm.expression =
      "range( (range($T," + s.toFixed(6) + "," + h.toFixed(6) + ") - " +
      s.toFixed(6) + ") / (" + h.toFixed(6) + " - " + s.toFixed(6) + "), 0, 1) ^ " +
      gamma.toFixed(6);
   pm.useSingleExpression = true;
   pm.generateOutput      = true;
   pm.createNewImage      = false;
   pm.executeOn( win.mainView );
}

// -------------------------------------------------------------------------
// SCNR — single pass, green reduction
// -------------------------------------------------------------------------
function applySCNR( win ) {
   var scnr = new SCNR;
   scnr.amount            = params.scnrAmount;
   scnr.protectionMethod  = params.scnrMethod;
   scnr.colorToRemove     = SCNR.Green;
   scnr.preserveLightness = true;
   scnr.executeOn( win.mainView );
}

// -------------------------------------------------------------------------
// Palette short name for auto-suffix
// -------------------------------------------------------------------------
function paletteShortName() {
   return ["SHO","HOO","HSO","OSH","SOH",
           "ForaxxS","ForaxxD","Custom"][params.paletteMode] || "SHO";
}

function buildOutputId() {
   // Palette name as prefix: SHO_Blended, HOO_Blended etc.
   // Strip leading underscore from outputId so _Blended → SHO_Blended not SHO__Blended
   var base = params.outputId.replace(/^\_/, "");
   return paletteShortName() + "_" + base;
}

// -------------------------------------------------------------------------
// Check if assigned images look linear (median below threshold)
// Returns array of warning strings, empty if all OK
// -------------------------------------------------------------------------
function checkLinearImages() {
   var warnings = [];
   var threshold = 0.01;
   var checks = [
      { id: params.haImageId,   label: "Ha"   },
      { id: params.oiiiImageId, label: "OIII" },
      { id: params.siiImageId,  label: "SII"  }
   ];
   for ( var i = 0; i < checks.length; i++ ) {
      var win = windowById( checks[i].id );
      if ( win && !win.isNull ) {
         var med = win.mainView.image.median();
         if ( med < threshold )
            warnings.push( checks[i].label + " (" + checks[i].id +
                           "): median=" + med.toFixed(5) + " — may be linear" );
      }
   }
   return warnings;
}

// -------------------------------------------------------------------------
// Save Recipe — print current settings to console as a copyable block
// -------------------------------------------------------------------------
function saveRecipe() {
   var PALETTE_NAMES = ["SHO","HOO","HSO","OSH","SOH",
                        "Foraxx (static)","Foraxx (dynamic)","Custom"];
   var METHOD_NAMES  = ["Maximum Mask","Additive Mask","Average Neutral","Maximum Neutral"];
   var COLOR_NAMES   = ["Red","Yellow","Green","Cyan","Blue","Magenta"];
   var LUM_NAMES     = ["Ha","SII","OIII","Weighted blend"];

   console.writeln( "" );
   console.writeln( "╔══════════════════════════════════════════════════╗" );
   console.writeln( "  " + SCRIPT_TITLE + " v" + SCRIPT_VERSION + " — Recipe" );
   console.writeln( "  " + (new Date).toLocaleString() );
   console.writeln( "╚══════════════════════════════════════════════════╝" );
   console.writeln( "  Ha:   " + params.haImageId );
   console.writeln( "  OIII: " + params.oiiiImageId );
   console.writeln( "  SII:  " + params.siiImageId );
   console.writeln( "" );
   console.writeln( "  Palette:      " + PALETTE_NAMES[params.paletteMode] );
   if ( params.paletteMode == 7 ) {
      console.writeln( "    R = " + params.custom_R_expr );
      console.writeln( "    G = " + params.custom_G_expr );
      console.writeln( "    B = " + params.custom_B_expr );
   }
   console.writeln( "" );
   console.writeln( "  Normalize:    " + (params.normalizeChannels ?
      "Yes — " + ["Median","Mean"][params.normalizationMode] +
      ", cap " + params.normScaleCap.toFixed(1) + "x" : "No") );
   console.writeln( "  Ha boost:     " + params.haAdjust.toFixed(2) );
   console.writeln( "  OIII boost:   " + params.oiiiAdjust.toFixed(2) );
   console.writeln( "  SII boost:    " + params.siiAdjust.toFixed(2) );
   console.writeln( "" );
   if ( params.haMaskEnabled )
      console.writeln( "  Ha mask:      " + COLOR_NAMES[params.haMaskColor] +
         "  strength=" + params.haMaskStrength.toFixed(2) +
         "  blur=" + params.haMaskBlurPasses + "x sigma=" + params.haMaskBlurSigma.toFixed(1) );
   if ( params.oiiiMaskEnabled )
      console.writeln( "  OIII mask:    " + COLOR_NAMES[params.oiiiMaskColor] +
         "  strength=" + params.oiiiMaskStrength.toFixed(2) +
         "  blur=" + params.oiiiMaskBlurPasses + "x sigma=" + params.oiiiMaskBlurSigma.toFixed(1) );
   if ( params.siiMaskEnabled )
      console.writeln( "  SII mask:     " + COLOR_NAMES[params.siiMaskColor] +
         "  strength=" + params.siiMaskStrength.toFixed(2) +
         "  blur=" + params.siiMaskBlurPasses + "x sigma=" + params.siiMaskBlurSigma.toFixed(1) );
   console.writeln( "" );
   if ( params.applySCNR )
      console.writeln( "  SCNR green:   amount=" + params.scnrAmount.toFixed(2) +
         "  method=" + METHOD_NAMES[params.scnrMethod] );
   if ( params.applyTone )
      console.writeln( "  Tone:         shadows=" + params.toneShadows.toFixed(3) +
         "  midpoint=" + params.toneMidpoint.toFixed(3) +
         "  highlights=" + params.toneHighlights.toFixed(3) );
   if ( params.applyLuminance ) {
      console.writeln( "  Luminance:    source=" + LUM_NAMES[params.lumMode] +
         "  strength=" + params.lumStrength.toFixed(2) );
      if ( params.lumMode == 3 )
         console.writeln( "    Ha=" + params.lumHaWeight.toFixed(2) +
            "  SII=" + params.lumSiiWeight.toFixed(2) +
            "  OIII=" + params.lumOiiiWeight.toFixed(2) );
   }
   if ( params.applyStars && params.starsImageId != "" )
      console.writeln( "  Stars:        " + params.starsImageId );
   console.writeln( "" );
   console.writeln( "  Output:       " + buildOutputId() );
   console.writeln( "══════════════════════════════════════════════════" );
   console.writeln( "" );
   Console.show();
}

// -------------------------------------------------------------------------
// Auto Settings — analyzes channel data and sets reasonable starting values
// Does NOT touch tone adjustment, luminance, or masks (too subjective)
// -------------------------------------------------------------------------
function autoSettings() {
   var haWin   = windowById( params.haImageId );
   var oiiiWin = windowById( params.oiiiImageId );
   var siiWin  = windowById( params.siiImageId );

   var needsSIIAuto = ( params.paletteMode != 1 );
   if ( !haWin || haWin.isNull || !oiiiWin || oiiiWin.isNull ||
        ( needsSIIAuto && ( !siiWin || siiWin.isNull ) ) ) {
      var autoMsg = ( params.paletteMode == 1 )
         ? "Auto Settings requires Ha and OIII to be assigned for HOO palette."
         : "Auto Settings requires all three channels to be assigned.";
      (new MessageBox( autoMsg, SCRIPT_TITLE, StdIcon.Warning, StdButton.Ok )).execute();
      return false;
   }

   var haImg   = haWin.mainView.image;
   var oiiiImg = oiiiWin.mainView.image;
   var siiImg  = ( !needsSIIAuto && siiWin && !siiWin.isNull )
      ? siiWin.mainView.image : null;

   var haMed   = haImg.median();
   var oiiiMed = oiiiImg.median();
   var siiMed  = siiImg ? siiImg.median() : haMed; // HOO: use Ha as placeholder

   console.writeln( "" );
   console.writeln( "══════════════════════════════════════" );
   console.writeln( "  Auto Settings" );
   console.writeln( "══════════════════════════════════════" );
   console.writeln( "  Ha:   " + haMed.toFixed(5) );
   console.writeln( "  OIII: " + oiiiMed.toFixed(5) );
   console.writeln( "  SII:  " + siiMed.toFixed(5) );
   console.writeln( "  Palette: " + paletteName() );

   var maxMed = Math.max( haMed, oiiiMed, siiMed );
   if ( maxMed < 0.001 ) maxMed = 0.001;

   // Mean vs Median — use mean if Ha signal fills most of the frame
   var signalFraction = haImg.mean() / Math.max( haImg.maximum(), 0.001 );
   params.normalizationMode = ( signalFraction > 0.15 ) ? 1 : 0;
   params.normalizeChannels = true;
   console.writeln( "  Signal fraction: " + signalFraction.toFixed(3) +
      "  → " + (params.normalizationMode == 1 ? "Mean" : "Median") );

   // Reset all boosts and masks to start clean
   params.haAdjust       = 0.0;
   params.oiiiAdjust     = 0.0;
   params.siiAdjust      = 0.0;
   params.haMaskEnabled  = false;
   params.oiiiMaskEnabled = false;
   params.siiMaskEnabled = false;
   params.applySCNR      = false;

   var isHOO = ( params.paletteMode == 1 );

   if ( isHOO ) {
      // ---------------------------------------------------------------
      // HOO auto logic
      // Ha drives red — modest warmth boost
      // OIII drives G+B — main color, boost proportionally to weakness
      // No SII (not used), no SCNR (HOO doesn't create green cast)
      // ---------------------------------------------------------------
      var oiiiRatioHOO = oiiiMed / Math.max( haMed, 0.001 );

      // Ha: slight boost to warm up the reds, scaled gently
      params.haAdjust = 0.10;

      // OIII: 0.20-0.35 scaled to weakness
      if ( oiiiRatioHOO < 0.5 )
         params.oiiiAdjust = 0.35;
      else if ( oiiiRatioHOO < 0.75 )
         params.oiiiAdjust = 0.28;
      else
         params.oiiiAdjust = 0.20;

      // Normalization cap — HOO often needs higher cap for weak OIII
      params.normScaleCap = ( oiiiRatioHOO < 0.5 ) ? 3.0 : 2.0;

      // OIII mask with Cyan — protects red Ha regions and background
      params.oiiiMaskEnabled    = true;
      params.oiiiMaskColor      = 3;   // Cyan
      params.oiiiMaskStrength   = 1.0;
      params.oiiiMaskBlurPasses = 1;
      params.oiiiMaskBlurSigma  = 7.0;

      // No SCNR — HOO doesn't generate green cast
      params.applySCNR = false;

      console.writeln( "  HOO mode:" );
      console.writeln( "    Ha boost:   " + params.haAdjust.toFixed(2) );
      console.writeln( "    OIII boost: " + params.oiiiAdjust.toFixed(2) +
         "  (OIII/Ha ratio=" + oiiiRatioHOO.toFixed(2) + ")" );
      console.writeln( "    OIII mask:  Cyan" );
      console.writeln( "    SCNR:       disabled" );

   } else {
      // ---------------------------------------------------------------
      // SHO auto logic (and all other palettes)
      // Ha: do not touch — any boost fights SCNR
      // OIII: 0.4-0.6 scaled to weakness relative to Ha
      // SII:  0.15-0.25 scaled to weakness relative to Ha
      // SCNR: 0.35 Maximum Mask — always needed for SHO
      // ---------------------------------------------------------------
      var oiiiRatioSHO = oiiiMed / Math.max( haMed, 0.001 );
      var siiRatioSHO  = siiMed  / Math.max( haMed, 0.001 );

      // OIII boost: 0.40-0.60 based on how weak OIII is
      if ( oiiiRatioSHO < 0.5 )
         params.oiiiAdjust = 0.60;
      else if ( oiiiRatioSHO < 0.7 )
         params.oiiiAdjust = 0.50;
      else if ( oiiiRatioSHO < 0.9 )
         params.oiiiAdjust = 0.40;
      else
         params.oiiiAdjust = 0.30;  // OIII close to Ha level — mild boost only

      // SII boost: 0.15-0.25 based on how weak SII is
      if ( siiRatioSHO < 0.5 )
         params.siiAdjust = 0.25;
      else if ( siiRatioSHO < 0.75 )
         params.siiAdjust = 0.20;
      else
         params.siiAdjust = 0.15;

      // Ha: intentionally left at 0.0
      params.haAdjust = 0.0;

      // Normalization cap scaled to weakest channel
      var weakestSHO = Math.min( oiiiMed, siiMed ) / maxMed;
      params.normScaleCap = ( weakestSHO < 0.4 ) ? 3.0 :
                            ( weakestSHO < 0.7 ) ? 2.5 : 2.0;

      // OIII mask: Blue — protects background and warm SII/Ha regions
      params.oiiiMaskEnabled    = true;
      params.oiiiMaskColor      = 4;   // Blue
      params.oiiiMaskStrength   = 1.0;
      params.oiiiMaskBlurPasses = 1;
      params.oiiiMaskBlurSigma  = 7.0;

      // SII mask: Red — protects background and OIII regions
      params.siiMaskEnabled    = true;
      params.siiMaskColor      = 0;   // Red
      params.siiMaskStrength   = 1.0;
      params.siiMaskBlurPasses = 1;
      params.siiMaskBlurSigma  = 7.0;

      // SCNR: 0.35 Maximum Mask — 0.35 is the sweet spot for SHO
      params.applySCNR  = true;
      params.scnrAmount = 0.35;
      params.scnrMethod = 0;

      // Magenta reduction enabled by default for SHO
      // Settings match manual workflow: Average Neutral, amount 1.0
      params.applyMagentaReduction = true;
      params.magentaAmount = 0.5;
      params.magentaMethod = 2;   // Average Neutral

      console.writeln( "  SHO mode:" );
      console.writeln( "    Ha boost:   0.00 (untouched — fights SCNR)" );
      console.writeln( "    OIII boost: " + params.oiiiAdjust.toFixed(2) +
         "  (OIII/Ha ratio=" + oiiiRatioSHO.toFixed(2) + ")" );
      console.writeln( "    SII boost:  " + params.siiAdjust.toFixed(2) +
         "  (SII/Ha ratio=" + siiRatioSHO.toFixed(2) + ")" );
      console.writeln( "    OIII mask:  Blue" );
      console.writeln( "    SII mask:   Red" );
      console.writeln( "    SCNR:       0.35 Maximum Mask" );
      console.writeln( "    Magenta:    enabled, amount=1.0, Average Neutral" );
      console.writeln( "    Scale cap:  " + params.normScaleCap.toFixed(1) );
   }

   console.writeln( "  Palette/tone/luminance: unchanged" );
   console.writeln( "══════════════════════════════════════" );
   Console.show();
   return true;
}

// Returns ImageWindow. Caller stores as previewDisplayWin.
// -------------------------------------------------------------------------
function preparePreviewWindow( win ) {
   return win;
}

// -------------------------------------------------------------------------
// Core pipeline
// -------------------------------------------------------------------------
function runPipeline( isPreview ) {
   // Determine which channels are required for the active palette
   var needsSII = ( params.paletteMode != 1 ); // HOO doesn't use SII

   if ( params.haImageId == "" || params.oiiiImageId == "" ||
        ( needsSII && params.siiImageId == "" ) ) {
      var msg = ( params.paletteMode == 1 )
         ? "HOO palette requires Ha and OIII to be assigned."
         : "Please assign all three channel images before running.";
      (new MessageBox( msg, SCRIPT_TITLE, StdIcon.Error, StdButton.Ok )).execute();
      return null;
   }
   var haWin   = windowById( params.haImageId );
   var oiiiWin = windowById( params.oiiiImageId );
   var siiWin  = needsSII ? windowById( params.siiImageId ) : haWin; // dummy for HOO
   if ( !haWin || !oiiiWin || ( needsSII && !siiWin ) ) {
      (new MessageBox( "One or more selected images could not be found.",
         SCRIPT_TITLE, StdIcon.Error, StdButton.Ok )).execute();
      return null;
   }

   var sfx    = isPreview ? "_prv" : "_work";
   var haId   = "_sho_ha"   + sfx;
   var oiiiId = "_sho_oiii" + sfx;
   var siiId  = "_sho_sii"  + sfx;
   var outId  = isPreview ? PREVIEW_WORK_ID : "_sho_combined_work";

   var haClone, oiiiClone, siiClone;
   if ( isPreview ) {
      haClone   = downsampleImage( haWin,   haId,   params.previewScale, true );
      oiiiClone = downsampleImage( oiiiWin, oiiiId, params.previewScale, true );
      siiClone  = downsampleImage( siiWin,  siiId,  params.previewScale, true );
   } else {
      haClone   = duplicateImage( haWin,   haId   );
      oiiiClone = duplicateImage( oiiiWin, oiiiId );
      siiClone  = duplicateImage( siiWin,  siiId  );
   }

   var haView   = haClone.mainView;
   var oiiiView = oiiiClone.mainView;
   var siiView  = siiClone.mainView;

   if ( params.normalizeChannels )
      normalizeChannels( haView, oiiiView, siiView );

   applyChannelAdjustments( haView, oiiiView, siiView );

   var combinedWin = combineChannels( haView, oiiiView, siiView, outId );
   if ( isPreview ) combinedWin.hide();

   // Apply color-masked channel boosts on the combined RGB image
   // (requires color image for hue-based masking)
   var anyMask = ( params.haMaskEnabled  && Math.abs(params.haAdjust)   > 0.001 ) ||
                 ( params.oiiiMaskEnabled && Math.abs(params.oiiiAdjust) > 0.001 ) ||
                 ( params.siiMaskEnabled  && Math.abs(params.siiAdjust)  > 0.001 );
   if ( anyMask ) applyColorMaskedBoosts( combinedWin );

   // Build luminance from original assigned images (not pipeline clones)
   var lumWin = null;
   if ( params.applyLuminance ) {
      console.writeln( "Building synthetic luminance (Rec.709 luma scaling)..." );
      lumWin = buildLuminanceSource( combinedWin.mainView, sfx );
   }

   // Always close preview intermediates — they serve no purpose after the
   // preview image is rendered. Only respect closeIntermediates for full runs.
   var shouldClose = isPreview ? true : params.closeIntermediates;
   if ( shouldClose ) {
      haClone.forceClose();
      oiiiClone.forceClose();
      siiClone.forceClose();
   }

   if ( lumWin ) applyLuminance( combinedWin, lumWin );

   var doSCNR = isPreview
      ? ( params.applySCNR && params.previewApplySCNR )
      : params.applySCNR;
   if ( doSCNR ) applySCNR( combinedWin );

   // Tone adjustment
   if ( params.applyTone ) applyToneAdjustment( combinedWin );


   // Magenta reduction — absolute last step before stars
   if ( params.applyMagentaReduction ) applyMagentaReduction( combinedWin );

   // Star recombination — screen blend, truly last step
   applyStarRecombination( combinedWin );

   if ( isPreview ) {
      return preparePreviewWindow( combinedWin );
   } else {
      var finalId = buildOutputId();
      combinedWin.mainView.id = finalId;
      return true;
   }
}

// -------------------------------------------------------------------------
// Full run
// -------------------------------------------------------------------------
function runSHOBlend() {
   console.writeln( "" );
   console.writeln( "════════════════════════════════════════════════" );
   console.writeln( " " + SCRIPT_TITLE + " v" + SCRIPT_VERSION + " — Full Run" );
   console.writeln( "════════════════════════════════════════════════" );
   console.writeln( " Palette:    " + paletteName() );
   console.writeln( " Normalize:  " + (params.normalizeChannels ? "Yes (cap " + params.normScaleCap.toFixed(1) + "x)" : "No") );
   console.writeln( " Ha:  " + params.haAdjust.toFixed(2) +
                    "  OIII: " + params.oiiiAdjust.toFixed(2) +
                    "  SII: "  + params.siiAdjust.toFixed(2) );
   var ok = runPipeline( false );
   if ( ok ) {
      console.writeln( "════════════════════════════════════════════════" );
      console.writeln( " Complete → " + buildOutputId() );
      console.writeln( "════════════════════════════════════════════════" );
      // Notify user pipeline is done — script window may be obscured
      (new MessageBox(
         "Full blend complete.\n\nOutput: " + buildOutputId(),
         SCRIPT_TITLE, StdIcon.Information, StdButton.Ok
      )).execute();
   }
   return ok;
}

// =========================================================================
// DIALOG
// =========================================================================

// =========================================================================
// NPBPreviewScrollBox — fluid zoom/pan preview (inspired by VeraLux v1.5.2)
// =========================================================================
const NPB_CURSOR_CROSS       = 13;
const NPB_CURSOR_CLOSED_HAND = 28;

var NPBPreviewScrollBox = class extends ScrollBox {
   constructor( parent ) {
      super( parent );
      this.bitmap          = null;
      this.zoomFactor      = 1.0;
      this.minZoom         = 0.05;
      this.maxZoom         = 16.0;
      this.dragging        = false;
      this.dragOrigin      = new Point( 0, 0 );
      this.dragScrollStart = new Point( 0, 0 );
      this.onZoomChanged   = null;
      this.autoScroll = true;
      this.tracking   = true;
      this.cursor     = new Cursor( NPB_CURSOR_CROSS );
      let self = this;
      this.onHorizontalScrollPosUpdated = function() { this.viewport.update(); };
      this.onVerticalScrollPosUpdated   = function() { this.viewport.update(); };
      this.viewport.onResize = function() { self._updateScrollRange(); };
      this.viewport.onMousePress = function( x, y, button ) {
         if ( ( button & 1 ) === 0 ) return;
         self.dragging        = true;
         self.dragOrigin      = new Point( x, y );
         self.dragScrollStart = new Point( self.horizontalScrollPosition, self.verticalScrollPosition );
         this.cursor = new Cursor( NPB_CURSOR_CLOSED_HAND );
      };
      this.viewport.onMouseRelease = function() {
         self.dragging = false;
         this.cursor   = new Cursor( NPB_CURSOR_CROSS );
      };
      this.viewport.onMouseMove = function( x, y ) {
         if ( self.dragging ) {
            self.horizontalScrollPosition = self.dragScrollStart.x + ( self.dragOrigin.x - x );
            self.verticalScrollPosition   = self.dragScrollStart.y + ( self.dragOrigin.y - y );
         }
      };
      this.viewport.onMouseWheel = function( x, y, delta ) {
         var oldZ = self.zoomFactor;
         var newZ = ( delta > 0 ) ? Math.min( oldZ * 1.25, self.maxZoom ) : Math.max( oldZ * 0.8, self.minZoom );
         if ( newZ === oldZ ) return;
         self._zoomAt( newZ, x, y );
         if ( self.onZoomChanged ) self.onZoomChanged( self.zoomFactor );
      };
      this.viewport.onPaint = function( x0, y0, x1, y1 ) {
         var g = new Graphics( this );
         g.fillRect( x0, y0, x1, y1, new Brush( 0xFF080808 ) );
         if ( self.bitmap ) {
            var bw = Math.round( self.bitmap.width  * self.zoomFactor );
            var bh = Math.round( self.bitmap.height * self.zoomFactor );
            var dx = ( self.maxHorizontalScrollPosition > 0 ) ? -self.horizontalScrollPosition : Math.floor( ( this.width  - bw ) / 2 );
            var dy = ( self.maxVerticalScrollPosition   > 0 ) ? -self.verticalScrollPosition   : Math.floor( ( this.height - bh ) / 2 );
            g.drawScaledBitmap( new Rect( dx, dy, dx + bw, dy + bh ), self.bitmap );
            g.pen = new Pen( 0xff444444, 0 );
            g.drawRect( dx - 1, dy - 1, dx + bw, dy + bh );
         } else {
            g.pen  = new Pen( 0xFF334466 );
            g.font = new Font( "Helvetica", 13 );
            var msg = "Click Preview / Refresh to render";
            var tw  = g.font.width( msg );
            g.drawText( Math.round( (this.width - tw) / 2 ), Math.round( this.height / 2 ) + 6, msg );
         }
         g.end();
      };
   }
   _updateScrollRange() {
      if ( !this.bitmap ) { this.setHorizontalScrollRange( 0, 0 ); this.setVerticalScrollRange( 0, 0 ); }
      else {
         var bw = Math.round( this.bitmap.width  * this.zoomFactor );
         var bh = Math.round( this.bitmap.height * this.zoomFactor );
         this.setHorizontalScrollRange( 0, Math.max( 0, bw - this.viewport.width ) );
         this.setVerticalScrollRange  ( 0, Math.max( 0, bh - this.viewport.height ) );
      }
      this.viewport.update();
   }
   _zoomAt( newZ, vx, vy ) {
      var ratio = newZ / this.zoomFactor;
      this.zoomFactor = newZ;
      this._updateScrollRange();
      this.horizontalScrollPosition = Math.max( 0, ( this.horizontalScrollPosition + vx ) * ratio - vx );
      this.verticalScrollPosition   = Math.max( 0, ( this.verticalScrollPosition   + vy ) * ratio - vy );
   }
   setBitmap( bmp ) {
      if ( this.bitmap ) this.bitmap.clear();
      this.bitmap = ( bmp && bmp.width > 0 ) ? bmp : null;
      this._updateScrollRange();
   }
   clearBitmap() {
      if ( this.bitmap ) { this.bitmap.clear(); this.bitmap = null; }
      this._updateScrollRange();
   }
   zoomIn()  { var n = Math.min( this.zoomFactor * 1.25, this.maxZoom ); this._zoomAt( n, Math.floor(this.viewport.width/2), Math.floor(this.viewport.height/2) ); if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor); }
   zoomOut() { var n = Math.max( this.zoomFactor * 0.8,  this.minZoom ); this._zoomAt( n, Math.floor(this.viewport.width/2), Math.floor(this.viewport.height/2) ); if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor); }
   zoom1to1() { this.zoomFactor=1.0; this.horizontalScrollPosition=0; this.verticalScrollPosition=0; this._updateScrollRange(); if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor); }
   zoomFit() {
      if ( !this.bitmap ) return;
      var z = Math.max( this.minZoom, Math.min( this.maxZoom, Math.min( this.viewport.width/this.bitmap.width, this.viewport.height/this.bitmap.height ) ) );
      this.zoomFactor=z; this.horizontalScrollPosition=0; this.verticalScrollPosition=0; this._updateScrollRange(); if(this.onZoomChanged)this.onZoomChanged(this.zoomFactor);
   }
};

var SHOBlenderDialog = class extends Dialog {
   constructor() {
      super();

      this.windowTitle = SCRIPT_TITLE + " v" + SCRIPT_VERSION;

      var self = this;

   // -----------------------------------------------------------------------
   // Header banner
   // -----------------------------------------------------------------------
   var headerLabel = new Label( self );
   headerLabel.text =
      SCRIPT_TITLE + " v" + SCRIPT_VERSION +
      "  |  Ha, OIII, SII required  |  Images must be: registered, aligned, gradient corrected, starless, and stretched to non-linear";
   headerLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   headerLabel.styleSheet =
      "background: #1a2a3a; color: #88bbdd; font-weight: bold; " +
      "padding: 6px 10px; border-radius: 3px; font-size: 11px;";

   // -----------------------------------------------------------------------
   // UI helpers
   // -----------------------------------------------------------------------
   function sectionLabel( text ) {
      var lbl = new Label;
      lbl.text = text;
      lbl.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
      lbl.styleSheet = "font-weight: bold; color: #88aaff; margin-top: 4px;";
      return lbl;
   }

   function hRule() {
      var f = new Frame;
      f.styleSheet = "background: #334455; border: none; min-height: 1px; max-height: 1px; margin: 1px 0;";
      return f;
   }

   function labeledRow( labelText, labelWidth, control ) {
      var lbl = new Label;
      lbl.text = labelText;
      lbl.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      lbl.minWidth = labelWidth;
      var s = new HorizontalSizer;
      s.spacing = 6;
      s.add( lbl );
      s.add( control, 100 );
      return s;
   }

   function indentRow( control ) {
      var s = new HorizontalSizer;
      s.addSpacing( 18 );
      s.add( control, 100 );
      return s;
   }

   // Control references for Auto sync — declared here so autoButton can update them
   var ctrl_haBoost, ctrl_oiiiBoost, ctrl_siiBoost;
   var ctrl_normCheck, ctrl_normMetric, ctrl_normCap;
   var ctrl_scnrCheck, ctrl_scnrAmount;
   var ctrl_magentaCheck, ctrl_magentaAmount, ctrl_magentaMethod;
   var ctrl_oiiiMaskCheck, ctrl_oiiiMaskColor;
   var ctrl_siiMaskCheck, ctrl_siiMaskColor;
   var ctrl_haCombo, ctrl_oiiiCombo, ctrl_siiCombo;

   // -----------------------------------------------------------------------
   // Channel Assignment
   // -----------------------------------------------------------------------
   var grayIds = getGrayscaleImageIds();

   // Linear warning label — defined early so makeChannelSelector can reference updateLinearWarning
   var linearWarningLabel = new Label;
   linearWarningLabel.text = "";
   linearWarningLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   linearWarningLabel.styleSheet = "color: #ff8800; font-weight: bold; font-size: 11px;";
   linearWarningLabel.visible = false;

   function updateLinearWarning() {
      var warnings = checkLinearImages();
      if ( warnings.length > 0 ) {
         linearWarningLabel.text = "⚠  Possible linear input: " + warnings.join( ", " );
         linearWarningLabel.visible = true;
      } else {
         linearWarningLabel.text = "";
         linearWarningLabel.visible = false;
      }
   }

   function makeChannelSelector( labelText, paramKey ) {
      var cb = new ComboBox;
      cb.addItem( "— none —" );
      for ( var i = 0; i < grayIds.length; i++ ) cb.addItem( grayIds[i] );
      var idx = grayIds.indexOf( params[paramKey] );
      cb.currentItem = ( idx >= 0 ) ? idx + 1 : 0;
      cb.paramKey = paramKey;
      cb.onItemSelected = function(i) {
         params[this.paramKey] = ( i == 0 ) ? "" : grayIds[i - 1];
         updateLinearWarning();
      };
      // Store reference for reset
      if      ( paramKey == "haImageId"   ) ctrl_haCombo   = cb;
      else if ( paramKey == "oiiiImageId" ) ctrl_oiiiCombo = cb;
      else if ( paramKey == "siiImageId"  ) ctrl_siiCombo  = cb;
      return labeledRow( labelText, 50, cb );
   }

   var channelControls = new Control( self );
   channelControls.sizer = new VerticalSizer;
   channelControls.sizer.margin = 4;
   channelControls.sizer.spacing = 4;
   var channelSizer = channelControls.sizer;
   channelSizer.add( makeChannelSelector( "Ha",   "haImageId"   ) );
   channelSizer.add( makeChannelSelector( "OIII", "oiiiImageId" ) );
   channelSizer.add( makeChannelSelector( "SII",  "siiImageId"  ) );

   // -----------------------------------------------------------------------
   // Channel Boost / Suppress
   // -----------------------------------------------------------------------
   function makeAdjustControl( labelText, paramKey ) {
      var nc = new NumericControl;
      nc.label.text     = labelText;
      nc.label.minWidth = 55;
      nc.slider.setRange( -100, 100 );
      nc.setRange( -1.0, 1.0 );
      nc.setPrecision( 2 );
      nc.setValue( params[paramKey] );
      nc.paramKey = paramKey;
      nc.toolTip =
         "0 = no change.  Effective multiplier = 1.0 + value.\n" +
         "Negative suppresses, positive boosts.\n" +
         "Applied after normalization.";
      nc.onValueUpdated = function(v) { params[this.paramKey] = v; };
      // Register for Auto sync
      if      ( paramKey == "haAdjust"   ) ctrl_haBoost   = nc;
      else if ( paramKey == "oiiiAdjust" ) ctrl_oiiiBoost = nc;
      else if ( paramKey == "siiAdjust"  ) ctrl_siiBoost  = nc;
      return nc;
   }

   var adjControls = new Control( self );
   adjControls.sizer = new VerticalSizer;
   adjControls.sizer.margin = 4;
   adjControls.sizer.spacing = 4;
   var adjSizer = adjControls.sizer;
   adjSizer.add( makeAdjustControl( "Ha",   "haAdjust"   ) );
   adjSizer.add( makeAdjustControl( "OIII", "oiiiAdjust" ) );
   adjSizer.add( makeAdjustControl( "SII",  "siiAdjust"  ) );

   // -----------------------------------------------------------------------
   // Color Masks — applied to channel boosts on the combined image
   // -----------------------------------------------------------------------
   var COLOR_NAMES = ["Red","Yellow","Green","Cyan","Blue","Magenta"];

   function makeMaskGroup( label, enableKey, colorKey, strengthKey,
                           blurPassesKey, blurSigmaKey ) {
      var grp = new GroupBox;
      grp.title = label + " channel mask";

      var enableCb = new CheckBox;
      enableCb.text    = "Apply color mask to " + label + " boost";
      enableCb.checked = params[enableKey];
      enableCb.enableKey = enableKey;
      enableCb.toolTip =
         "When enabled, the " + label + " channel boost slider no longer applies globally.\n" +
         "Instead the same boost value is applied only where the selected color\n" +
         "exists in the combined image — protecting black backgrounds and other\n" +
         "color regions from being pushed in the wrong direction.\n\n" +
         "Example: OIII boost 0.5 with blue mask enabled — blue regions get\n" +
         "boosted by 0.5, warm/red regions and black background are untouched.\n\n" +
         "The boost targets only the RGB output channel(s) that " + label + " drives\n" +
         "in the active palette (e.g. blue channel only in SHO).\n\n" +
         "For Foraxx and Custom palettes, boost scales the full RGB pixel\n" +
         "since sources are blended across channels.";
      enableCb.onCheck = function(v) { params[this.enableKey] = v; };

      var colorCombo = new ComboBox;
      for ( var ci = 0; ci < COLOR_NAMES.length; ci++ )
         colorCombo.addItem( COLOR_NAMES[ci] );
      colorCombo.currentItem = params[colorKey];
      colorCombo.colorKey = colorKey;
      colorCombo.toolTip = "Hue range to use as the boost mask.";
      colorCombo.onItemSelected = function(i) { params[this.colorKey] = i; };

      // Register for Auto sync
      if      ( enableKey == "oiiiMaskEnabled" ) { ctrl_oiiiMaskCheck = enableCb; ctrl_oiiiMaskColor = colorCombo; }
      else if ( enableKey == "siiMaskEnabled"  ) { ctrl_siiMaskCheck  = enableCb; ctrl_siiMaskColor  = colorCombo; }

      var strengthCtrl = new NumericControl;
      strengthCtrl.label.text     = "Mask strength";
      strengthCtrl.label.minWidth = 90;
      strengthCtrl.slider.setRange( 0, 100 );
      strengthCtrl.setRange( 0.0, 1.0 );
      strengthCtrl.setPrecision( 2 );
      strengthCtrl.setValue( params[strengthKey] );
      strengthCtrl.strengthKey = strengthKey;
      strengthCtrl.toolTip = "How broadly the mask selects the target hue. 1.0 = tight selection.";
      strengthCtrl.onValueUpdated = function(v) { params[this.strengthKey] = v; };

      var blurPassesCombo = new ComboBox;
      blurPassesCombo.addItem( "No blur" );
      blurPassesCombo.addItem( "1 pass" );
      blurPassesCombo.addItem( "2 passes" );
      blurPassesCombo.addItem( "3 passes" );
      blurPassesCombo.currentItem = params[blurPassesKey];
      blurPassesCombo.blurPassesKey = blurPassesKey;
      blurPassesCombo.toolTip =
         "How many times to blur the mask with Gaussian convolution.\n" +
         "More passes = softer mask edges = more gradual color transition.\n" +
         "Each pass applies the same sigma strength, compounding the blur effect.";
      blurPassesCombo.onItemSelected = function(i) { params[this.blurPassesKey] = i; };

      var blurSigmaCtrl = new NumericControl;
      blurSigmaCtrl.label.text     = "Blur sigma";
      blurSigmaCtrl.label.minWidth = 90;
      blurSigmaCtrl.slider.setRange( 0, 100 );
      blurSigmaCtrl.setRange( 1.0, 20.0 );
      blurSigmaCtrl.setPrecision( 1 );
      blurSigmaCtrl.setValue( params[blurSigmaKey] );
      blurSigmaCtrl.blurSigmaKey = blurSigmaKey;
      blurSigmaCtrl.toolTip = "Gaussian sigma for mask blur. 7.0 is a good starting point.";
      blurSigmaCtrl.onValueUpdated = function(v) { params[this.blurSigmaKey] = v; };

      var gsizer = new VerticalSizer;
      gsizer.margin = 6; gsizer.spacing = 4;
      gsizer.add( enableCb );
      gsizer.add( indentRow( labeledRow( "Color",  55, colorCombo      ) ) );
      gsizer.add( indentRow( strengthCtrl                               ) );
      gsizer.add( indentRow( labeledRow( "Blur",   55, blurPassesCombo ) ) );
      gsizer.add( indentRow( blurSigmaCtrl                              ) );
      grp.sizer = gsizer;
      return grp;
   }

   var haMaskGroup   = makeMaskGroup( "Ha",   "haMaskEnabled",   "haMaskColor",
      "haMaskStrength",   "haMaskBlurPasses",   "haMaskBlurSigma"   );
   var oiiiMaskGroup = makeMaskGroup( "OIII", "oiiiMaskEnabled", "oiiiMaskColor",
      "oiiiMaskStrength", "oiiiMaskBlurPasses", "oiiiMaskBlurSigma" );
   var siiMaskGroup  = makeMaskGroup( "SII",  "siiMaskEnabled",  "siiMaskColor",
      "siiMaskStrength",  "siiMaskBlurPasses",  "siiMaskBlurSigma"  );

   var colorMaskControls = new Control( self );
   colorMaskControls.sizer = new VerticalSizer;
   colorMaskControls.sizer.margin = 4;
   colorMaskControls.sizer.spacing = 4;
   colorMaskControls.sizer.add( haMaskGroup );
   colorMaskControls.sizer.addSpacing( 4 );
   colorMaskControls.sizer.add( oiiiMaskGroup );
   colorMaskControls.sizer.addSpacing( 4 );
   colorMaskControls.sizer.add( siiMaskGroup );

   // Color mask SectionBar wired after onToggleSection is defined below
   var colorMaskBar = new SectionBar( self, "Additional Masked Boost" );
   colorMaskBar.setSection( colorMaskControls );

   adjSizer.addSpacing( 4 );
   adjSizer.add( colorMaskBar );
   adjSizer.add( colorMaskControls );

   // -----------------------------------------------------------------------
   // Palette
   // -----------------------------------------------------------------------
   var paletteModeCombo = new ComboBox;
   paletteModeCombo.addItem( "SHO  (R=SII  G=Ha  B=OIII)" );
   paletteModeCombo.addItem( "HOO  (R=Ha  G=OIII  B=OIII)" );
   paletteModeCombo.addItem( "HSO  (R=Ha  G=SII  B=OIII)" );
   paletteModeCombo.addItem( "OSH  (R=OIII  G=SII  B=Ha)" );
   paletteModeCombo.addItem( "SOH  (R=SII  G=OIII  B=Ha)" );
   paletteModeCombo.addItem( "Foraxx (static)  — adjustable weighted blend" );
   paletteModeCombo.addItem( "Foraxx (dynamic) — true per-pixel blend" );
   paletteModeCombo.addItem( "Custom  (user-defined PixelMath)" );
   paletteModeCombo.currentItem = params.paletteMode;
   paletteModeCombo.toolTip =
      "SHO: classic Hubble palette. Gold/amber SII, teal OIII.\n" +
      "HOO: natural reds for Ha, cyan-blue for OIII. Good for strong OIII targets.\n" +
      "HSO: Ha drives red, SII in green. More natural than SHO, keeps SII structure.\n" +
      "OSH: OIII drives red. Unusual, interesting on OIII-dominant targets.\n" +
      "SOH: SII drives red, OIII in green. Good for SII-rich targets.\n" +
      "Foraxx (static): weighted blend of channels using adjustable sliders.\n" +
      "Foraxx (dynamic): true ForaxX per-pixel blend using ^ and ~ operators.\n" +
      "  SII where OIII is strong, Ha where OIII is weak — more nuanced than static.\n" +
      "Custom: enter your own PixelMath using Ha, OIII, SII as tokens.";

   function makeWeightCtrl( labelText, paramKey ) {
      var nc = new NumericControl;
      nc.label.text     = labelText;
      nc.label.minWidth = 155;
      nc.slider.setRange( 0, 100 );
      nc.setRange( 0.0, 1.0 );
      nc.setPrecision( 2 );
      nc.setValue( params[paramKey] );
      nc.paramKey = paramKey;
      nc.onValueUpdated = function(v) { params[this.paramKey] = v; };
      return nc;
   }

   var foraxxGroup = new GroupBox;
   foraxxGroup.title = "Foraxx Blend Weights";
   var foraxxSizer = new VerticalSizer;
   foraxxSizer.margin = 6; foraxxSizer.spacing = 3;
   foraxxSizer.add( makeWeightCtrl( "R  SII weight",  "foraxx_R_SII"  ) );
   foraxxSizer.add( makeWeightCtrl( "R  Ha weight",   "foraxx_R_Ha"   ) );
   foraxxSizer.add( makeWeightCtrl( "G  Ha weight",   "foraxx_G_Ha"   ) );
   foraxxSizer.add( makeWeightCtrl( "G  OIII weight", "foraxx_G_OIII" ) );
   foraxxSizer.add( makeWeightCtrl( "B  OIII weight", "foraxx_B_OIII" ) );
   foraxxSizer.add( makeWeightCtrl( "B  Ha weight",   "foraxx_B_Ha"   ) );
   foraxxGroup.sizer = foraxxSizer;

   var rEdit, gEdit, bEdit;  // forward references for expr edits

   function makeExprEditRef( labelText, paramKey, refSetter ) {
      var edit = new Edit;
      edit.text = params[paramKey];
      edit.paramKey = paramKey;
      edit.toolTip = "Tokens: Ha  OIII  SII — standard PixelMath syntax.\nPI operators ^ (power) and ~ (negation) are supported.";
      edit.onTextUpdated = function(t) { params[this.paramKey] = t; };
      refSetter( edit );
      return labeledRow( labelText, 35, edit );
   }

   var customGroup = new GroupBox;
   customGroup.title = "Custom Expressions  (tokens: Ha  OIII  SII)";
   var customSizer = new VerticalSizer;
   customSizer.margin = 6; customSizer.spacing = 4;
   customSizer.add( makeExprEditRef( "R =", "custom_R_expr", function(e){ rEdit = e; } ) );
   customSizer.add( makeExprEditRef( "G =", "custom_G_expr", function(e){ gEdit = e; } ) );
   customSizer.add( makeExprEditRef( "B =", "custom_B_expr", function(e){ bEdit = e; } ) );
   customGroup.sizer = customSizer;

   function updatePaletteVisibility() {
      foraxxGroup.visible = ( params.paletteMode == 5 );
      customGroup.visible  = ( params.paletteMode == 7 );
   }
   updatePaletteVisibility();
   paletteModeCombo.onItemSelected = function(i) {
      params.paletteMode = i;
      updatePaletteVisibility();
   };

   var paletteControls = new Control( self );
   paletteControls.sizer = new VerticalSizer;
   paletteControls.sizer.margin = 4;
   paletteControls.sizer.spacing = 4;
   var paletteSizer = paletteControls.sizer;
   paletteSizer.add( labeledRow( "Palette", 55, paletteModeCombo ) );
   paletteSizer.addSpacing( 4 );
   paletteSizer.add( foraxxGroup );
   paletteSizer.add( customGroup );
   // -----------------------------------------------------------------------
   // Normalization
   // -----------------------------------------------------------------------
   var normCheckBox = new CheckBox;
   ctrl_normCheck = normCheckBox;
   normCheckBox.text    = "Normalize channels before combination";
   normCheckBox.checked = !!params.normalizeChannels;
   normCheckBox.toolTip =
      "Scales OIII and SII brightness to match Ha.\n" +
      "The scale cap below limits how aggressively weak channels are boosted.";
   normCheckBox.onCheck = function(v) {
      params.normalizeChannels = v;
      normModeCombo.enabled    = v;
      normScaleCapCtrl.enabled = v;
   };

   var normModeCombo = new ComboBox;
   ctrl_normMetric = normModeCombo;
   normModeCombo.addItem( "Median" );
   normModeCombo.addItem( "Mean" );
   normModeCombo.currentItem = params.normalizationMode;
   normModeCombo.enabled = params.normalizeChannels;
   normModeCombo.toolTip =
      "Median: uses the middle pixel brightness value. Resistant to bright stars\n" +
      "and hot pixels. Best for most narrowband targets where bright emission\n" +
      "covers a minority of the frame. Default for most situations.\n\n" +
      "Mean: uses the average of all pixel values. Bright nebula regions pull\n" +
      "it higher. Better choice when emission fills most of the frame (e.g.\n" +
      "North America Nebula, Orion, large mosaics). The console log shows the\n" +
      "actual scale factors used so you can compare both modes on your data.";
   normModeCombo.onItemSelected = function(i) { params.normalizationMode = i; };

   var normScaleCapCtrl = new NumericControl;
   ctrl_normCap = normScaleCapCtrl;
   normScaleCapCtrl.label.text     = "Max scale cap";
   normScaleCapCtrl.label.minWidth = 90;
   normScaleCapCtrl.slider.setRange( 10, 50 );
   normScaleCapCtrl.setRange( 1.0, 5.0 );
   normScaleCapCtrl.setPrecision( 1 );
   normScaleCapCtrl.setValue( params.normScaleCap );
   normScaleCapCtrl.enabled = params.normalizeChannels;
   normScaleCapCtrl.toolTip =
      "Maximum multiplier applied to OIII and SII during normalization.\n" +
      "2.0 means a weak OIII can be scaled up at most 2x its original level.\n" +
      "Lower values preserve channel dynamic range for masking.\n" +
      "Higher values bring weak channels closer to Ha brightness.\n" +
      "Console output shows the actual scale factor used vs the cap.";
   normScaleCapCtrl.onValueUpdated = function(v) { params.normScaleCap = v; };

   var normControls = new Control( self );
   normControls.sizer = new VerticalSizer;
   normControls.sizer.margin = 4;
   normControls.sizer.spacing = 4;
   var normSizer = normControls.sizer;
   normSizer.add( normCheckBox );
   normSizer.add( indentRow( labeledRow( "Metric", 65, normModeCombo ) ) );
   normSizer.addSpacing( 2 );
   normSizer.add( indentRow( normScaleCapCtrl ) );

   // -----------------------------------------------------------------------
   // Stretch
   // -----------------------------------------------------------------------
   // -----------------------------------------------------------------------
   // SCNR — single pass, green reduction
   // -----------------------------------------------------------------------
   var scnrCheckBox = new CheckBox;
   ctrl_scnrCheck = scnrCheckBox;
   scnrCheckBox.text    = "Apply SCNR green reduction";
   scnrCheckBox.checked = !!params.applySCNR;
   scnrCheckBox.onCheck = function(v) { params.applySCNR = v; };

   var scnrAmountCtrl = new NumericControl;
   ctrl_scnrAmount = scnrAmountCtrl;
   scnrAmountCtrl.label.text     = "Amount";
   scnrAmountCtrl.label.minWidth = 55;
   scnrAmountCtrl.slider.setRange( 0, 100 );
   scnrAmountCtrl.setRange( 0.0, 1.0 );
   scnrAmountCtrl.setPrecision( 2 );
   scnrAmountCtrl.setValue( params.scnrAmount );
   scnrAmountCtrl.toolTip =
      "How aggressively to reduce the green channel.\n" +
      "0.0 = no effect. 1.0 = maximum removal.\n\n" +
      "Important: SCNR and Ha suppression compound each other.\n" +
      "If you are already suppressing Ha (which fills the green\n" +
      "channel in SHO), less SCNR is needed. Start at 0.20 and\n" +
      "increase only if a visible green cast remains after Ha suppression.\n" +
      "0.20-0.40 is the recommended range for pre-suppressed data.";
   scnrAmountCtrl.onValueUpdated = function(v) { params.scnrAmount = v; };

   var scnrMethodCombo = new ComboBox;
   scnrMethodCombo.addItem( "Maximum Mask" );
   scnrMethodCombo.addItem( "Additive Mask" );
   scnrMethodCombo.addItem( "Average Neutral" );
   scnrMethodCombo.addItem( "Maximum Neutral" );
   scnrMethodCombo.currentItem = params.scnrMethod;
   scnrMethodCombo.toolTip =
      "Maximum Mask: protects pixels where green is already dominant.\n" +
      "Most conservative option.\n\n" +
      "Additive Mask: slightly more aggressive than Maximum Mask.\n" +
      "Adds a correction term. Can remove more green but risks clipping.\n\n" +
      "Average Neutral: reduces green toward the average of red and blue.\n" +
      "More uniform reduction across the whole image. Good when green\n" +
      "is a pervasive even cast rather than patchy.\n\n" +
      "Maximum Neutral: reduces green toward whichever of red or blue\n" +
      "is higher at each pixel. Most aggressive of the four. Use carefully\n" +
      "at low amounts — can produce unnatural color at higher values.";
   scnrMethodCombo.onItemSelected = function(i) { params.scnrMethod = i; };

   var scnrControls = new Control( self );
   scnrControls.sizer = new VerticalSizer;
   scnrControls.sizer.margin = 4;
   scnrControls.sizer.spacing = 4;
   var scnrSizer = scnrControls.sizer;
   scnrSizer.add( scnrCheckBox );
   scnrSizer.add( indentRow( scnrAmountCtrl ) );
   scnrSizer.add( indentRow( labeledRow( "Method", 50, scnrMethodCombo ) ) );

   // -----------------------------------------------------------------------
   // Synthetic Luminance
   // -----------------------------------------------------------------------
   var lumCheckBox = new CheckBox;
   lumCheckBox.text    = "Apply synthetic luminance";
   lumCheckBox.checked = !!params.applyLuminance;
   lumCheckBox.toolTip =
      "Scales RGB channels to match the luminance structure of the selected source.\n" +
      "Hue and color ratios are preserved — only brightness structure changes.\n\n" +
      "Use SII for emission nebulae (traces dense shell edges best).\n" +
      "Use Ha for targets where Ha traces fine structural detail.\n" +
      "Use OIII on OIII-dominant targets like planetary nebulae.\n\n" +
      "Strength 0.5 = blend halfway between original and new luminance.\n" +
      "Strength 1.0 = full replacement.";

   var lumModeCombo = new ComboBox;
   lumModeCombo.addItem( "Ha" );
   lumModeCombo.addItem( "SII" );
   lumModeCombo.addItem( "OIII" );
   lumModeCombo.addItem( "Weighted blend" );
   lumModeCombo.currentItem = params.lumMode;
   lumModeCombo.enabled = params.applyLuminance;
   lumModeCombo.toolTip =
      "Which channel drives the luminance replacement.\n" +
      "Ha: good for targets where Ha traces fine structure.\n" +
      "SII: often best for emission nebulae — SII traces dense shell edges.\n" +
      "OIII: useful on OIII-dominant targets like planetary nebulae.\n" +
      "Weighted blend: combines all three with adjustable weights.";

   function makeWeightCtrl2( labelText, paramKey ) {
      var nc = new NumericControl;
      nc.label.text     = labelText;
      nc.label.minWidth = 95;
      nc.slider.setRange( 0, 100 );
      nc.setRange( 0.0, 1.0 );
      nc.setPrecision( 2 );
      nc.setValue( params[paramKey] );
      nc.paramKey = paramKey;
      nc.toolTip = "Relative weight. Auto-normalized so all three always sum to 1.0.";
      nc.onValueUpdated = function(v) { params[this.paramKey] = v; };
      return nc;
   }

   var lumWeightGroup = new GroupBox;
   lumWeightGroup.title = "Luminance Blend Weights  (auto-normalized)";
   var lumWeightSizer = new VerticalSizer;
   lumWeightSizer.margin = 6; lumWeightSizer.spacing = 3;
   lumWeightSizer.add( makeWeightCtrl2( "Ha weight",   "lumHaWeight"   ) );
   lumWeightSizer.add( makeWeightCtrl2( "SII weight",  "lumSiiWeight"  ) );
   lumWeightSizer.add( makeWeightCtrl2( "OIII weight", "lumOiiiWeight" ) );
   lumWeightGroup.sizer = lumWeightSizer;

   var lumStrengthCtrl = new NumericControl;
   lumStrengthCtrl.label.text     = "L strength";
   lumStrengthCtrl.label.minWidth = 75;
   lumStrengthCtrl.slider.setRange( 0, 100 );
   lumStrengthCtrl.setRange( 0.0, 1.0 );
   lumStrengthCtrl.setPrecision( 2 );
   lumStrengthCtrl.setValue( params.lumStrength );
   lumStrengthCtrl.enabled = params.applyLuminance;
   lumStrengthCtrl.toolTip =
      "How strongly the new luminance source replaces the existing one.\n" +
      "0.5 = blend halfway between original and new luminance (default).\n" +
      "1.0 = full replacement.\n" +
      "0.0 = no change.";
   lumStrengthCtrl.onValueUpdated = function(v) { params.lumStrength = v; };

   function updateLumVisibility() {
      lumWeightGroup.visible    = ( params.applyLuminance && params.lumMode == 3 );
      lumModeCombo.enabled      = params.applyLuminance;
      lumStrengthCtrl.enabled   = params.applyLuminance;
   }
   updateLumVisibility();

   lumCheckBox.onCheck = function(v) {
      params.applyLuminance = v;
      updateLumVisibility();
   };
   lumModeCombo.onItemSelected = function(i) {
      params.lumMode = i;
      updateLumVisibility();
   };

   var lumControls = new Control( self );
   lumControls.sizer = new VerticalSizer;
   lumControls.sizer.margin = 4;
   lumControls.sizer.spacing = 4;
   var lumSizer = lumControls.sizer;
   lumSizer.add( lumCheckBox );
   lumSizer.add( indentRow( labeledRow( "Source",   50, lumModeCombo    ) ) );
   lumSizer.add( indentRow( lumStrengthCtrl                               ) );
   lumSizer.addSpacing( 2 );
   lumSizer.add( lumWeightGroup );

   // -----------------------------------------------------------------------
   // Output
   // -----------------------------------------------------------------------
   // -----------------------------------------------------------------------
   // Star Recombination
   // -----------------------------------------------------------------------
   var starsCheckBox = new CheckBox;
   starsCheckBox.text    = "Add stars back  (screen blend)";
   starsCheckBox.checked = !!params.applyStars;
   starsCheckBox.toolTip =
      "Recombines a star image with the starless blended output.\n" +
      "Uses screen blend: ~(~starless * ~stars)\n\n" +
      "Run on a starless image. Select your star image from the dropdown.\n" +
      "Works with RGB or grayscale star images.\n" +
      "Runs as the absolute last step — after magenta reduction.";
   starsCheckBox.onCheck = function(v) { params.applyStars = v; };

   // All open images — stars can be RGB or grayscale
   var allImageIds = [];
   var wins = ImageWindow.windows;
   for ( var wi = 0; wi < wins.length; wi++ ) {
      var wid = wins[wi].mainView.id;
      if ( wid.charAt(0) != '_' ) allImageIds.push( wid );
   }

   var starsCombo = new ComboBox;
   starsCombo.addItem( "— none —" );
   for ( var si = 0; si < allImageIds.length; si++ )
      starsCombo.addItem( allImageIds[si] );
   var starsIdx = allImageIds.indexOf( params.starsImageId );
   starsCombo.currentItem = ( starsIdx >= 0 ) ? starsIdx + 1 : 0;
   starsCombo.toolTip =
      "The star image to blend back in. Should be a stretched star image\n" +
      "on a black background — the output of StarXTerminator or equivalent.\n" +
      "Can be RGB or grayscale.";
   starsCombo.onItemSelected = function(i) {
      params.starsImageId = ( i == 0 ) ? "" : allImageIds[i - 1];
   };

   var starsControls = new Control( self );
   starsControls.sizer = new VerticalSizer;
   starsControls.sizer.margin = 4;
   starsControls.sizer.spacing = 4;
   starsControls.sizer.add( starsCheckBox );
   starsControls.sizer.add( indentRow( labeledRow( "Stars", 55, starsCombo ) ) );

   var starsBar = makeSection( starsControls, "Star Recombination", false );

   var outputIdEdit = new Edit;
   outputIdEdit.text = params.outputId;
   outputIdEdit.onTextUpdated = function(t) { params.outputId = t; };

   var closeIntermediatesCheckBox = new CheckBox;
   closeIntermediatesCheckBox.text    = "Close working clones after combination";
   closeIntermediatesCheckBox.checked = !!params.closeIntermediates;
   closeIntermediatesCheckBox.onCheck = function(v) { params.closeIntermediates = v; };

   var outputControls = new Control( self );
   outputControls.sizer = new VerticalSizer;
   outputControls.sizer.margin = 4;
   outputControls.sizer.spacing = 4;
   var outputSizer = outputControls.sizer;
   outputSizer.add( labeledRow( "Output ID", 65, outputIdEdit ) );
   outputSizer.add( closeIntermediatesCheckBox );

   // -----------------------------------------------------------------------
   // Tone Adjustment — shadows, midpoint, highlights
   // Applied via HistogramTransformation to all channels equally, last step
   // -----------------------------------------------------------------------
   var toneCheckBox = new CheckBox;
   toneCheckBox.text    = "Apply tone adjustment";
   toneCheckBox.checked = !!params.applyTone;
   toneCheckBox.toolTip =
      "Applies shadows, midpoint, and highlights adjustment as the final step.\n" +
      "All three channels are adjusted equally.\n" +
      "Defaults are neutral: Shadows=0.0, Midpoint=0.5, Highlights=1.0.";
   toneCheckBox.onCheck = function(v) { params.applyTone = v; };

   var toneShadowsCtrl = new NumericControl;
   toneShadowsCtrl.label.text     = "Shadows";
   toneShadowsCtrl.label.minWidth = 75;
   toneShadowsCtrl.slider.setRange( 0, 1000 );
   toneShadowsCtrl.setRange( 0.0, 1.0 );
   toneShadowsCtrl.setPrecision( 3 );
   toneShadowsCtrl.setValue( params.toneShadows );
   toneShadowsCtrl.toolTip =
      "Black point. 0.0 = no change (default). 1.0 = everything black.\n" +
      "Increase to clip shadows and deepen blacks.\n" +
      "Must stay below Highlights value.";
   toneShadowsCtrl.onValueUpdated = function(v) { params.toneShadows = v; };

   var toneMidpointCtrl = new NumericControl;
   toneMidpointCtrl.label.text     = "Midpoint";
   toneMidpointCtrl.label.minWidth = 75;
   toneMidpointCtrl.slider.setRange( 0, 100 );
   toneMidpointCtrl.setRange( 0.0, 1.0 );
   toneMidpointCtrl.setPrecision( 3 );
   toneMidpointCtrl.setValue( params.toneMidpoint );
   toneMidpointCtrl.toolTip =
      "Midtone brightness (PI native MTF value).\n" +
      "0.5 = neutral, no change (default).\n" +
      "Below 0.5 = brighter midtones.\n" +
      "Above 0.5 = darker midtones.\n" +
      "Works the same as the midpoint slider in PI's HistogramTransformation.";
   toneMidpointCtrl.onValueUpdated = function(v) { params.toneMidpoint = v; };

   var toneHighlightsCtrl = new NumericControl;
   toneHighlightsCtrl.label.text     = "Highlights";
   toneHighlightsCtrl.label.minWidth = 75;
   toneHighlightsCtrl.slider.setRange( 0, 1000 );
   toneHighlightsCtrl.setRange( 0.0, 1.0 );
   toneHighlightsCtrl.setPrecision( 3 );
   toneHighlightsCtrl.setValue( params.toneHighlights );
   toneHighlightsCtrl.toolTip =
      "White point. 1.0 = no change (default). 0.0 = everything white.\n" +
      "Decrease to compress highlights and brighten the image.\n" +
      "Must stay above Shadows value.";
   toneHighlightsCtrl.onValueUpdated = function(v) { params.toneHighlights = v; };

   var toneControls = new Control( self );
   toneControls.sizer = new VerticalSizer;
   toneControls.sizer.margin = 4;
   toneControls.sizer.spacing = 4;
   var toneSizer = toneControls.sizer;
   toneSizer.add( toneCheckBox );
   toneSizer.add( indentRow( toneShadowsCtrl ) );
   toneSizer.add( indentRow( toneMidpointCtrl ) );
   toneSizer.add( indentRow( toneHighlightsCtrl ) );

   // -----------------------------------------------------------------------
   // LEFT COLUMN — SectionBar collapsible sections (GHS pattern)
   // -----------------------------------------------------------------------
   var onToggleSection = function( bar, beginToggle ) {
      if ( !beginToggle ) {
         self.adjustToContents();
         self.setVariableSize();
      }
   };

   function makeSection( container, title, expanded ) {
      var bar = new SectionBar( self, title );
      bar.setSection( container );
      bar.onToggleSection = onToggleSection;
      if ( !expanded ) bar.toggleSection();
      return bar;
   }

   var channelBar  = makeSection( channelControls,  "Channel Assignment",                          true  );
   var adjBar      = makeSection( adjControls,       "Channel Boost / Suppress  (0 = no change)",  true  );
   var paletteBar  = makeSection( paletteControls,   "Palette Mode",                               true  );
   var normBar     = makeSection( normControls,      "Normalization",                               true  );
   var scnrBar     = makeSection( scnrControls,      "SCNR Green Reduction",                        true  );
   var toneBar     = makeSection( toneControls,      "Tone Adjustment",                             false );
   var lumBar      = makeSection( lumControls,       "Synthetic Luminance",  false );
   var outputBar   = makeSection( outputControls,    "Output",                                      true  );

   // Magenta Reduction — own SectionBar, collapsed by default
   var magentaControls = new Control( self );
   magentaControls.sizer = new VerticalSizer;
   magentaControls.sizer.margin = 4;
   magentaControls.sizer.spacing = 4;
   var magentaSizer = magentaControls.sizer;

   var magentaCheckBox = new CheckBox;
   ctrl_magentaCheck = magentaCheckBox;
   magentaCheckBox.text    = "Apply magenta reduction  (runs last)";
   magentaCheckBox.checked = !!params.applyMagentaReduction;
   magentaCheckBox.toolTip =
      "Runs as the absolute last step — after green SCNR, tone, and luminance.\n" +
      "Green SCNR is fully finished before this runs so there is no interference.\n\n" +
      "Equivalent to manually: Invert → SCNR green (Average Neutral 1.0) → Invert.\n" +
      "Use to clean up magenta blobs that remain after green SCNR.";
   magentaCheckBox.onCheck = function(v) { params.applyMagentaReduction = v; };

   var magentaAmountCtrl = new NumericControl;
   ctrl_magentaAmount = magentaAmountCtrl;
   magentaAmountCtrl.label.text     = "Amount";
   magentaAmountCtrl.label.minWidth = 55;
   magentaAmountCtrl.slider.setRange( 0, 100 );
   magentaAmountCtrl.setRange( 0.0, 1.0 );
   magentaAmountCtrl.setPrecision( 2 );
   magentaAmountCtrl.setValue( params.magentaAmount );
   magentaAmountCtrl.toolTip =
      "1.0 matches the manual workflow: Invert → SCNR Average Neutral 1.0 → Invert.";
   magentaAmountCtrl.onValueUpdated = function(v) { params.magentaAmount = v; };

   var magentaMethodCombo = new ComboBox;
   ctrl_magentaMethod = magentaMethodCombo;
   magentaMethodCombo.addItem( "Maximum Mask" );
   magentaMethodCombo.addItem( "Additive Mask" );
   magentaMethodCombo.addItem( "Average Neutral" );
   magentaMethodCombo.addItem( "Maximum Neutral" );
   magentaMethodCombo.currentItem = params.magentaMethod;
   magentaMethodCombo.toolTip =
      "Protection method for the inverted SCNR pass.\n" +
      "Average Neutral: neutralizes green by averaging with surrounding channels.\n" +
      "Maximum Mask: most conservative, protects dominant channels.";
   magentaMethodCombo.onItemSelected = function(i) { params.magentaMethod = i; };

   magentaSizer.add( magentaCheckBox );
   magentaSizer.add( indentRow( magentaAmountCtrl ) );
   magentaSizer.add( indentRow( labeledRow( "Method", 50, magentaMethodCombo ) ) );

   var magentaBar  = makeSection( magentaControls,  "Magenta Reduction  (invert / SCNR / invert)",  false );

   // Wire color mask bar now that onToggleSection is defined
   colorMaskBar.onToggleSection = onToggleSection;
   colorMaskBar.toggleSection();  // start collapsed

   // -----------------------------------------------------------------------
   // LEFT COLUMN — steps 1-7: setup and channel correction
   // -----------------------------------------------------------------------
   var leftSizer = new VerticalSizer;
   leftSizer.spacing = 2;
   // LEFT COLUMN: Channel Assignment, Palette Mode, Additional Masked Boost
   leftSizer.add( channelBar  ); leftSizer.add( channelControls  );
   leftSizer.add( paletteBar  ); leftSizer.add( paletteControls  );
   leftSizer.add( adjBar      ); leftSizer.add( adjControls      );
   leftSizer.addStretch();

   var leftFrame = new Control( self );
   leftFrame.setFixedWidth( LEFT_COL_W );
   leftFrame.sizer = leftSizer;

   // -----------------------------------------------------------------------
   // HUE / SATURATION section — right column, step 9
   // Single hue range selector with optional mask
   // -----------------------------------------------------------------------

   // -----------------------------------------------------------------------
   // RIGHT PANEL — steps 8-11: refinement controls
   // -----------------------------------------------------------------------
   var rightPanelSizer = new VerticalSizer;
   rightPanelSizer.spacing = 2;
   // RIGHT PANEL: Normalization, SCNR, Magenta, Tone, Luminance, Output
   rightPanelSizer.add( normBar     ); rightPanelSizer.add( normControls     );
   rightPanelSizer.add( scnrBar     ); rightPanelSizer.add( scnrControls     );
   rightPanelSizer.add( magentaBar  ); rightPanelSizer.add( magentaControls  );
   rightPanelSizer.add( toneBar     ); rightPanelSizer.add( toneControls     );
   rightPanelSizer.add( lumBar      ); rightPanelSizer.add( lumControls      );
   rightPanelSizer.add( starsBar    ); rightPanelSizer.add( starsControls    );
   rightPanelSizer.add( outputBar   ); rightPanelSizer.add( outputControls   );
   rightPanelSizer.addStretch();

   var rightPanelFrame = new Control( self );
   rightPanelFrame.setFixedWidth( LEFT_COL_W );
   rightPanelFrame.sizer = rightPanelSizer;

   // -----------------------------------------------------------------------
   // RIGHT COLUMN: ScrollBox + viewport (ExoTransit pattern)
   // Native scroll bars, viewport renders image at zoom scale
   // -----------------------------------------------------------------------
   var previewScrollBox = new NPBPreviewScrollBox( self );
   previewScrollBox.setMinSize( PREVIEW_MIN_W, PREVIEW_MIN_H );
   var previewDisplayWin = null;

   previewScrollBox.onZoomChanged = function( z ) {
      zoomLevelLabel.text = "Zoom: " + ( z * 100 ).toFixed(0) + "%";
   };

   previewScrollBox.onResize = function( w, h ) {
      previewPanelW = w; previewPanelH = h;
   };

   // Zoom buttons
   var zoomInButton = new PushButton;
   zoomInButton.text = "  +  ";
   zoomInButton.toolTip = "Zoom in. Mouse wheel also zooms.";
   zoomInButton.onClick = function() { previewScrollBox.zoomIn(); };

   var zoomOutButton = new PushButton;
   zoomOutButton.text = "  −  ";
   zoomOutButton.toolTip = "Zoom out. Mouse wheel also zooms.";
   zoomOutButton.onClick = function() { previewScrollBox.zoomOut(); };

   var zoomFitButton = new PushButton;
   zoomFitButton.text = "Fit";
   zoomFitButton.toolTip = "Zoom to fit preview in available space.";
   zoomFitButton.onClick = function() { previewScrollBox.zoomFit(); };

   var zoom100Button = new PushButton;
   zoom100Button.text = "100%";
   zoom100Button.toolTip = "Zoom to 100% (1:1 pixels).";
   zoom100Button.onClick = function() { previewScrollBox.zoom1to1(); };

   var zoomLevelLabel = new Label;
   zoomLevelLabel.text = "Zoom: fit";
   zoomLevelLabel.text = "Zoom: " + ( previewScrollBox.zoomFactor * 100 ).toFixed(0) + "%";
   zoomLevelLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   zoomLevelLabel.styleSheet = "color: #667799; min-width: 75px;";

   var zoomRow = new HorizontalSizer;
   zoomRow.spacing = 4;
   zoomRow.add( zoomLevelLabel );
   zoomRow.addStretch();
   zoomRow.add( zoomOutButton );
   zoomRow.add( zoomInButton );
   zoomRow.addSpacing( 6 );
   zoomRow.add( zoomFitButton );
   zoomRow.add( zoom100Button );

   // Preview options
   var previewScaleCombo = new ComboBox;
   previewScaleCombo.addItem( "1/2  (best quality)" );
   previewScaleCombo.addItem( "1/4  (recommended)" );
   previewScaleCombo.addItem( "1/8  (fastest)" );
   var scaleMap = [2, 4, 8];
   var si = scaleMap.indexOf( params.previewScale );
   previewScaleCombo.currentItem = ( si >= 0 ) ? si : 1;
   previewScaleCombo.toolTip =
      "Pipeline downsample quality.\n" +
      "1/8 = fastest, 1/2 = sharpest detail.";
   previewScaleCombo.onItemSelected = function(i) { params.previewScale = scaleMap[i]; };

   var previewSCNRCheckBox = new CheckBox;
   previewSCNRCheckBox.text    = "SCNR in preview";
   previewSCNRCheckBox.checked = !!params.previewApplySCNR;
   previewSCNRCheckBox.onCheck = function(v) { params.previewApplySCNR = v; };

   var previewOptionsRow = new HorizontalSizer;
   previewOptionsRow.spacing = 8;
   previewOptionsRow.add( labeledRow( "Quality", 45, previewScaleCombo ) );
   previewOptionsRow.addSpacing( 6 );
   previewOptionsRow.add( previewSCNRCheckBox );
   previewOptionsRow.addStretch();

   var previewStatusLabel = new Label;
   previewStatusLabel.text = "No preview generated yet";
   previewStatusLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   previewStatusLabel.styleSheet = "color: #445566; font-style: italic; font-size: 10px;";

   var previewButton = new PushButton;
   previewButton.text = "  Preview / Refresh";
   previewButton.icon = self.scaledResource( ":/icons/find.png" );
   previewButton.toolTip =
      "Run pipeline on downsampled copy.\n" +
      "Mouse wheel zooms, scroll bars pan when zoomed in.";
   previewButton.onClick = function() {
      previewStatusLabel.text = "Rendering...";
      processEvents();
      try {
         var resultWin = runPipeline( true );
         if ( resultWin ) {
            if ( previewDisplayWin ) {
               try { previewDisplayWin.forceClose(); } catch(e) {}
               previewDisplayWin = null;
            }
            previewDisplayWin = resultWin;
            var bmp = previewDisplayWin.mainView.image.render();
            previewScrollBox.setBitmap( bmp );
            previewScrollBox.zoomFit();
            previewStatusLabel.text =
               "1/" + params.previewScale + "  |  stretched" +
               "  |  wheel=zoom  scroll=pan";
            // Reset mask toggle if showing
            showMaskToggle.text = "  Show Mask";
            showMaskToggle.checked = false;
         } else {
            previewStatusLabel.text = "Preview failed — check channel assignments.";
         }
      } catch(e) {
         previewStatusLabel.text = "Error: " + e.message;
         console.criticalln( "Preview error: " + e.message );
      }
   };

   // Mask channel selector and toggle
   var maskChannelCombo = new ComboBox;
   maskChannelCombo.addItem( "Ha mask" );
   maskChannelCombo.addItem( "OIII mask" );
   maskChannelCombo.addItem( "SII mask" );
   maskChannelCombo.currentItem = 1;  // default OIII
   maskChannelCombo.toolTip = "Which channel's mask to display when Show Mask is active.";
   maskChannelCombo.setFixedWidth( 90 );

   var showMaskToggle = new PushButton;
   showMaskToggle.text    = "  Show Mask";
   showMaskToggle.icon    = self.scaledResource( ":/icons/find.png" );
   showMaskToggle.checked = false;
   showMaskToggle.toolTip =
      "Displays the selected channel's color mask in the preview panel.\n" +
      "Lets you see exactly which pixels will be boosted.\n\n" +
      "Run Preview / Refresh first, then toggle Show Mask to inspect.\n" +
      "Adjust color, strength, and blur, then toggle again to update.\n" +
      "Click Show Mask again or Preview / Refresh to return to the image.";

   var maskPreviewWin = null;  // holds the currently displayed mask window

   showMaskToggle.onClick = function() {
      // If already showing mask, toggle back to combined image
      if ( maskPreviewWin ) {
         try { maskPreviewWin.forceClose(); } catch(e) {}
         maskPreviewWin = null;
         showMaskToggle.text = "  Show Mask";
         // Restore combined image
         var combinedWin = windowById( PREVIEW_WORK_ID );
         if ( combinedWin ) {
            previewDisplayWin = combinedWin;
            previewStatusLabel.text = "Combined image";
         }
         return;
      }

      // Need a combined image first
      var combinedWin = windowById( PREVIEW_WORK_ID );
      if ( !combinedWin ) {
         previewStatusLabel.text = "Run Preview / Refresh first.";
         return;
      }

      // Determine which channel to show
      var channels = [ "ha", "oiii", "sii" ];
      var ch = channels[ maskChannelCombo.currentItem ];
      var colorKey    = ch + "MaskColor";
      var strengthKey = ch + "MaskStrength";
      var blurKey     = ch + "MaskBlurPasses";
      var sigmaKey    = ch + "MaskBlurSigma";

      previewStatusLabel.text = "Building mask...";
      processEvents();

      var maskId = "_npb_inline_mask";
      closeWindowById( maskId );

      maskPreviewWin = buildColorMask(
         combinedWin.mainView,
         params[colorKey],
         params[strengthKey],
         params[blurKey],
         params[sigmaKey],
         maskId
      );

      if ( maskPreviewWin ) {
         maskPreviewWin.hide();  // keep it hidden — render inline only
         previewDisplayWin = maskPreviewWin;
         var bmpM = maskPreviewWin.mainView.image.render();
         previewScrollBox.setBitmap( bmpM );
         previewScrollBox.zoomFit();
         showMaskToggle.text = "  Show Image";
         previewStatusLabel.text = ch.toUpperCase() + " mask  |  click Show Image to return";
      } else {
         previewStatusLabel.text = "Mask build failed.";
      }
   };

   // When channel changes while mask is showing, auto-refresh mask
   maskChannelCombo.onItemSelected = function(i) {
      if ( maskPreviewWin ) {
         // Close current mask and rebuild for new channel
         try { maskPreviewWin.forceClose(); } catch(e) {}
         maskPreviewWin = null;
         showMaskToggle.onClick();
      }
   };

   var maskPreviewRow = new HorizontalSizer;
   maskPreviewRow.spacing = 6;
   maskPreviewRow.add( maskChannelCombo );
   maskPreviewRow.add( showMaskToggle );
   maskPreviewRow.addStretch();

   var previewButtonRow = new HorizontalSizer;
   previewButtonRow.spacing = 8;
   previewButtonRow.add( previewButton );
   previewButtonRow.addStretch();
   previewButtonRow.add( previewStatusLabel );

   var rightSizer = new VerticalSizer;
   rightSizer.spacing = 6;
   rightSizer.add( sectionLabel( "Preview" ) );
   rightSizer.add( hRule() );
   rightSizer.addSpacing( 2 );
   rightSizer.add( previewScrollBox, 100 );
   rightSizer.addSpacing( 4 );
   rightSizer.add( zoomRow );
   rightSizer.addSpacing( 2 );
   rightSizer.add( previewOptionsRow );
   rightSizer.add( maskPreviewRow );
   rightSizer.add( previewButtonRow );

   // -----------------------------------------------------------------------
   // Buttons
   // -----------------------------------------------------------------------
   var runButton = new PushButton;
   runButton.text = "  Run Full Blend";
   runButton.icon = self.scaledResource( ":/icons/execute.png" );
   runButton.styleSheet = "font-weight: bold; padding: 4px 16px;";
   runButton.onClick = function() { runSHOBlend(); };

   var autoButton = new PushButton;
   autoButton.text = "  Auto";
   autoButton.icon = self.scaledResource( ":/icons/process.png" );
   autoButton.styleSheet = "padding: 4px 10px;";
   autoButton.toolTip =
      "Analyzes your channel data and sets reasonable starting values for:\n" +
      "  • Normalization mode (Median vs Mean)\n" +
      "  • Normalization scale cap\n" +
      "  • Channel boost sliders with palette-aware masks\n" +
      "  • SCNR at 0.35 for SHO / disabled for HOO\n" +
      "  • Magenta reduction enabled for SHO\n\n" +
      "Does NOT touch palette, tone adjustment, luminance, or masks.\n" +
      "This is a starting point — review and adjust to taste, then\n" +
      "click Preview / Refresh or Run Full Blend.";
   autoButton.onClick = function() {
      if ( autoSettings() ) {
         // Sync all UI controls to match what auto just set
         if ( ctrl_haBoost   ) ctrl_haBoost.setValue( params.haAdjust );
         if ( ctrl_oiiiBoost ) ctrl_oiiiBoost.setValue( params.oiiiAdjust );
         if ( ctrl_siiBoost  ) ctrl_siiBoost.setValue( params.siiAdjust );

         if ( ctrl_normCheck  ) ctrl_normCheck.checked = !!params.normalizeChannels;
         if ( ctrl_normMetric ) ctrl_normMetric.currentItem = params.normalizationMode;
         if ( ctrl_normCap    ) ctrl_normCap.setValue( params.normScaleCap );

         if ( ctrl_scnrCheck  ) ctrl_scnrCheck.checked = !!params.applySCNR;
         if ( ctrl_scnrAmount ) ctrl_scnrAmount.setValue( params.scnrAmount );

         if ( ctrl_magentaCheck  ) ctrl_magentaCheck.checked = !!params.applyMagentaReduction;
         if ( ctrl_magentaAmount ) ctrl_magentaAmount.setValue( params.magentaAmount );
         if ( ctrl_magentaMethod ) ctrl_magentaMethod.currentItem = params.magentaMethod;

         if ( ctrl_oiiiMaskCheck ) ctrl_oiiiMaskCheck.checked = !!params.oiiiMaskEnabled;
         if ( ctrl_oiiiMaskColor ) ctrl_oiiiMaskColor.currentItem = params.oiiiMaskColor;
         if ( ctrl_siiMaskCheck  ) ctrl_siiMaskCheck.checked = !!params.siiMaskEnabled;
         if ( ctrl_siiMaskColor  ) ctrl_siiMaskColor.currentItem = params.siiMaskColor;

         // Trigger preview so result is immediately visible
         previewButton.onClick();
      }
   };

   var saveRecipeButton = new PushButton;
   saveRecipeButton.text = "Save Recipe";
   saveRecipeButton.icon = self.scaledResource( ":/icons/list.png" );
   saveRecipeButton.toolTip =
      "Print all current settings to the PI console as a readable block.\n" +
      "Open the console to copy and save the output.";
   saveRecipeButton.onClick = function() { saveRecipe(); };

   var resetButton = new PushButton;
   resetButton.text = "Reset Defaults";
   resetButton.icon = self.scaledResource( ":/icons/reload.png" );
   resetButton.onClick = function() {
      for ( var k in DEFAULT_PARAMS ) params[k] = DEFAULT_PARAMS[k];

      // Sync all UI controls in real time — same approach as Auto
      if ( ctrl_haBoost   ) ctrl_haBoost.setValue( params.haAdjust );
      if ( ctrl_oiiiBoost ) ctrl_oiiiBoost.setValue( params.oiiiAdjust );
      if ( ctrl_siiBoost  ) ctrl_siiBoost.setValue( params.siiAdjust );

      if ( ctrl_normCheck  ) ctrl_normCheck.checked = !!params.normalizeChannels;
      if ( ctrl_normMetric ) ctrl_normMetric.currentItem = params.normalizationMode;
      if ( ctrl_normCap    ) ctrl_normCap.setValue( params.normScaleCap );

      if ( ctrl_scnrCheck  ) ctrl_scnrCheck.checked = !!params.applySCNR;
      if ( ctrl_scnrAmount ) ctrl_scnrAmount.setValue( params.scnrAmount );

      if ( ctrl_magentaCheck  ) ctrl_magentaCheck.checked = !!params.applyMagentaReduction;
      if ( ctrl_magentaAmount ) ctrl_magentaAmount.setValue( params.magentaAmount );
      if ( ctrl_magentaMethod ) ctrl_magentaMethod.currentItem = params.magentaMethod;

      if ( ctrl_oiiiMaskCheck ) ctrl_oiiiMaskCheck.checked = !!params.oiiiMaskEnabled;
      if ( ctrl_oiiiMaskColor ) ctrl_oiiiMaskColor.currentItem = params.oiiiMaskColor;
      if ( ctrl_siiMaskCheck  ) ctrl_siiMaskCheck.checked = !!params.siiMaskEnabled;
      if ( ctrl_siiMaskColor  ) ctrl_siiMaskColor.currentItem = params.siiMaskColor;

      // Reset channel dropdowns to none
      if ( ctrl_haCombo   ) ctrl_haCombo.currentItem   = 0;
      if ( ctrl_oiiiCombo ) ctrl_oiiiCombo.currentItem = 0;
      if ( ctrl_siiCombo  ) ctrl_siiCombo.currentItem  = 0;

      previewStatusLabel.text = "Defaults restored.";
   };

   var closeButton = new PushButton;
   closeButton.text = "Close";
   closeButton.icon = self.scaledResource( ":/icons/close.png" );
   closeButton.onClick = function() { self.done(0); };

   // Run initial linear check
   updateLinearWarning();

   // -----------------------------------------------------------------------
   // Help dialog
   // -----------------------------------------------------------------------
   function showHelpDialog() {
      var dlg = new Dialog();
      dlg.windowTitle = SCRIPT_TITLE + " v" + SCRIPT_VERSION + " — Help";
      dlg.userResizable = true;
      dlg.minWidth = 600;
      dlg.minHeight = 500;

      var helpText = new TextBox( dlg );
      helpText.readOnly = true;
      helpText.useRichText = true;
      helpText.text = "<html><body style='font-family:sans-serif; font-size:10pt;'>" +

"<h2>Narrowband Palette Blender v" + SCRIPT_VERSION + "</h2>" +
"<p>Combines Ha, OIII, and SII narrowband stacks into a color image using " +
"palette-aware channel mapping, masked boosts, normalization, SCNR, and optional " +
"luminance replacement. All processing uses working clones — your originals are never modified.</p>" +

"<hr/><h3>Before You Start</h3>" +
"<p>Each channel image should be prepared before loading into this script:</p>" +
"<ul>" +
"<li><b>Registered and aligned</b> — all three channels must be pixel-aligned</li>" +
"<li><b>Cropped</b> — same frame dimensions</li>" +
"<li><b>Gradient corrected</b> — run DBE or GraXpert before combining</li>" +
"<li><b>Starless</b> — recommended, avoids color halos around stars</li>" +
"<li><b>Stretched to non-linear</b> — run your stretch (GHS, HT, MaskedStretch) on each channel individually before using this script. Linear images will produce flat, unusable results.</li>" +
"</ul>" +

"<hr/><h3>Recommended Workflow</h3>" +
"<ol>" +
"<li>Load your Ha, OIII, and SII images in PixInsight</li>" +
"<li>Open the script and assign channels at the top</li>" +
"<li>Select your palette (SHO for classic Hubble look, HOO for natural colors)</li>" +
"<li>Click <b>Auto</b> — this analyzes your data and sets all controls to a reasonable starting point</li>" +
"<li>Click <b>Preview / Refresh</b> to see the result at reduced resolution</li>" +
"<li>Adjust any sliders and refresh again until satisfied</li>" +
"<li>Click <b>Run Full Blend</b> to produce the full resolution output</li>" +
"<li>Click <b>Save Recipe</b> to log your settings to the console for future reference</li>" +
"</ol>" +

"<hr/><h3>Channel Assignment</h3>" +
"<p>Assign your Ha, OIII, and SII grayscale images. For HOO palette, SII can be left as none — it is not used in HOO combination.</p>" +

"<hr/><h3>Palette Mode</h3>" +
"<p>Selects how channels are mapped to RGB output:</p>" +
"<ul>" +
"<li><b>SHO</b> — classic Hubble palette. SII=Red, Ha=Green, OIII=Blue. Gold/amber regions, teal OIII.</li>" +
"<li><b>HOO</b> — natural looking. Ha=Red, OIII=Green+Blue. Strong reds with cyan/teal OIII. Good for OIII-dominant targets.</li>" +
"<li><b>HSO</b> — Ha=Red, SII=Green, OIII=Blue. More natural than SHO.</li>" +
"<li><b>OSH</b> — OIII=Red, SII=Green, Ha=Blue. Unusual, good for OIII-dominant targets.</li>" +
"<li><b>SOH</b> — SII=Red, OIII=Green, Ha=Blue. Good for SII-rich targets.</li>" +
"<li><b>Foraxx (static)</b> — weighted blend of SHO and HOO channels.</li>" +
"<li><b>Foraxx (dynamic)</b> — true per-pixel Foraxx blend. SII where OIII is strong, Ha where OIII is weak.</li>" +
"<li><b>Custom</b> — enter your own PixelMath expressions using Ha, OIII, SII as tokens.</li>" +
"</ul>" +

"<hr/><h3>Channel Boost / Suppress</h3>" +
"<p>Adjusts the brightness of each channel before combination. 0 = no change. Positive values boost, negative values suppress.</p>" +
"<p><b>Important:</b> If a mask is enabled for a channel, this slider no longer applies globally. Instead the boost is applied only where the target color exists in the combined image, protecting black backgrounds and other color regions.</p>" +

"<hr/><h3>Additional Masked Boost</h3>" +
"<p>Each channel can have a color mask applied to its boost. When enabled, the boost only affects pixels matching the selected hue range.</p>" +
"<ul>" +
"<li><b>Color</b> — which hue to target. For SHO: OIII=Blue, SII=Red, Ha=Green. For HOO: OIII=Cyan.</li>" +
"<li><b>Mask strength</b> — how tightly the hue is selected. 1.0 = tight, 0.5 = broader selection.</li>" +
"<li><b>Blur passes</b> — softens mask edges. 1 pass is usually enough.</li>" +
"<li><b>Blur sigma</b> — size of the blur kernel. 7.0 is a good default.</li>" +
"</ul>" +
"<p>Use the <b>Ha / OIII / SII mask</b> dropdown and <b>Show Mask</b> button below the preview to visualize the mask before running. Adjust settings and click Show Mask again to update.</p>" +

"<hr/><h3>Normalization</h3>" +
"<p>Scales channels so they have the same brightness before combination. Prevents one channel from dominating the result.</p>" +
"<ul>" +
"<li><b>Median</b> — normalizes to the median pixel value. Good for targets that don't fill the frame.</li>" +
"<li><b>Mean</b> — normalizes to the mean pixel value. Better for large targets that fill most of the frame.</li>" +
"<li><b>Max scale cap</b> — limits how much any channel can be scaled up. Prevents very weak channels from being boosted too aggressively. 2.0-3.0 is typical.</li>" +
"</ul>" +

"<hr/><h3>SCNR Green Reduction</h3>" +
"<p>Removes the green cast that is typical in SHO palette images. SCNR (Selective Color Noise Reduction) suppresses the green channel where it is dominant.</p>" +
"<ul>" +
"<li><b>Amount</b> — how aggressively to remove green. 0.35 is a good starting point for SHO.</li>" +
"<li><b>Method</b> — Average Neutral is recommended and matches the manual PI workflow.</li>" +
"</ul>" +
"<p>For HOO palette, SCNR is typically not needed and is disabled by Auto.</p>" +

"<hr/><h3>Magenta Reduction</h3>" +
"<p>Removes magenta color casts using an invert/SCNR/invert technique. Runs as the absolute last step in the pipeline so it does not interfere with the green SCNR pass.</p>" +
"<p>Equivalent to manually running: Invert → SCNR Green (Average Neutral, 1.0) → Invert on the final output.</p>" +
"<ul>" +
"<li><b>Amount</b> — 1.0 matches the manual workflow and is the recommended default.</li>" +
"<li><b>Method</b> — Average Neutral recommended.</li>" +
"</ul>" +

"<hr/><h3>Tone Adjustment</h3>" +
"<p>Applies a curves-style adjustment to the final image using shadows, midpoint, and highlights controls.</p>" +
"<ul>" +
"<li><b>Shadows</b> — clips the dark end. 0.0 = no clipping.</li>" +
"<li><b>Midpoint</b> — gamma adjustment. 0.5 = neutral. Lower = brighter, higher = darker.</li>" +
"<li><b>Highlights</b> — clips the bright end. 1.0 = no clipping.</li>" +
"</ul>" +

"<hr/><h3>Synthetic Luminance</h3>" +
"<p>Replaces the luminance structure of the combined image with a selected channel. Useful for bringing out fine structural detail while preserving the color palette.</p>" +
"<ul>" +
"<li><b>Source</b> — Ha, SII, OIII, or a weighted blend. SII often gives the best structural detail on emission nebulae.</li>" +
"<li><b>L strength</b> — 0.5 blends halfway between original and new luminance. 1.0 = full replacement.</li>" +
"</ul>" +

"<hr/><h3>Output</h3>" +
"<ul>" +
"<li><b>Output ID</b> — base name for the output image. The palette name is prepended automatically. Default _Blended produces SHO_Blended, HOO_Blended, etc.</li>" +
"<li><b>Close working clones</b> — removes intermediate working images after the blend is complete. Keeps your workspace tidy.</li>" +
"</ul>" +

"<hr/><h3>Auto Button</h3>" +
"<p>Analyzes your channel data and sets all controls to a palette-aware starting point:</p>" +
"<p><b>SHO mode:</b> Ha left at 0 (boosting Ha fights SCNR), OIII boosted 0.40-0.60 based on weakness, SII boosted 0.15-0.25, both masks enabled, SCNR at 0.35, magenta reduction enabled.</p>" +
"<p><b>HOO mode:</b> Ha given a slight warmth boost, OIII boosted 0.20-0.35 based on weakness with cyan mask, SCNR disabled.</p>" +
"<p>All controls update visually after Auto runs so you can see what was set and adjust from there.</p>" +

"<hr/><h3>Save Recipe</h3>" +
"<p>Prints all current settings to the PixInsight console in a readable block. Use this after finding a combination you like so you can reproduce it later.</p>" +

"<hr/><h3>Tips</h3>" +
"<ul>" +
"<li>Use Preview / Refresh at 1/4 quality for fast iterations, switch to 1/2 for final check before full run</li>" +
"<li>The Show Mask feature requires a preview to have been run first</li>" +
"<li>Mask strength controls the hue selection width — try lowering it if the mask isn't selecting enough of the target color</li>" +
"<li>For SHO targets with very weak OIII, try setting the scale cap to 3.0 and let normalization do more of the work before applying channel boosts</li>" +
"<li>Synthetic luminance from SII on the C9.25 gives excellent fine detail on emission nebulae</li>" +
"</ul>" +

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

   var helpButton = new PushButton;
   helpButton.text = "Help";
   helpButton.icon = self.scaledResource( ":/icons/help.png" );
   helpButton.toolTip = "Open the help documentation.";
   helpButton.onClick = function() { showHelpDialog(); };

   var buttonSizer = new HorizontalSizer;
   buttonSizer.spacing = 8;
   buttonSizer.add( runButton );
   buttonSizer.addSpacing( 4 );
   buttonSizer.add( autoButton );
   buttonSizer.addSpacing( 8 );
   buttonSizer.add( saveRecipeButton );
   buttonSizer.addSpacing( 8 );
   buttonSizer.add( helpButton );
   buttonSizer.addStretch();
   buttonSizer.add( resetButton );
   buttonSizer.add( closeButton );

   var footerLabel = new Label;
   footerLabel.text =
      SCRIPT_TITLE + " v" + SCRIPT_VERSION +
      "  |  Originals are never modified. All operations use working clones.";
   footerLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   footerLabel.styleSheet = "color: #334455; font-style: italic; font-size: 10px;";

   // -----------------------------------------------------------------------
   // Main layout: fixed left column, stretching right preview
   // -----------------------------------------------------------------------
   var columnSizer = new HorizontalSizer;
   columnSizer.spacing = 8;
   columnSizer.add( leftFrame );
   columnSizer.add( rightSizer, 100 );
   columnSizer.add( rightPanelFrame );

   this.sizer = new VerticalSizer;
   this.sizer.margin  = 12;
   this.sizer.spacing = 10;
   this.sizer.add( headerLabel );
   this.sizer.add( linearWarningLabel );
   this.sizer.add( columnSizer, 100 );
   this.sizer.add( hRule() );
   this.sizer.add( buttonSizer );
   this.sizer.add( footerLabel );

      this.adjustToContents();
      this.setMinSize();
      this.userResizable = true;
   }
};

// V8: class inheritance replaces prototype pattern

// -------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------
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
   Console.writeln( "" );
   Console.writeln( "+==============================================+" );
   Console.writeln( "|                                              |" );
   Console.writeln( "|   * * * * * * * * * * * * * * * * * * * *    |" );
   Console.writeln( "|                                              |" );
   Console.writeln( "|          Narrowband Palette Blender          |" );
   Console.writeln( "|        Ha  *  OIII  *  SII  ->  Color        |" );
   Console.writeln( "|                                              |" );
   Console.writeln( "|   * * * * * * * * * * * * * * * * * * * *    |" );
   Console.writeln( "|                                              |" );
   Console.writeln( "|    v" + SCRIPT_VERSION + "  |  Author: Brannon Quel  |  2025    |" );
   Console.writeln( "|                                              |" );
   Console.writeln( "+==============================================+" );
   Console.writeln( "" );

   console.hide();
   if ( ImageWindow.windows.length == 0 ) {
      (new MessageBox(
         "No images are open. Please open your Ha, OIII, and SII images first.",
         SCRIPT_TITLE, StdIcon.Error, StdButton.Ok
      )).execute();
      return;
   }
   var dlg = new SHOBlenderDialog();
   dlg.execute();
}

main();
