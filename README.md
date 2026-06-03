# PhotonDumpsterFire

![PhotonDumpsterFire](PhotonDumpsterFire.png)

PixInsight astrophotography utilities and workflow tools.

**Everything is Fine.**

PhotonDumpsterFire is a collection of PixInsight scripts focused on astrophotography analysis, workflow enhancement, image inspection, and image processing. These tools were developed to solve real-world astrophotography problems encountered during data acquisition and processing.

---

# Installation

## Recommended: PixInsight Update Repository

PhotonDumpsterFire can be installed and updated directly through the PixInsight Update System.

1. Open PixInsight.
2. Select **Resources → Updates → Manage Repositories**.
3. Click **Add**.
4. Enter the following repository URL:

```text
https://raw.githubusercontent.com/brannonq/PhotonDumpsterFire/main/
```

5. Click **OK**.
6. Click **Check for Updates**.
7. Select **PhotonDumpsterFire** from the available packages list.
8. If PixInsight warns that the repository is unsigned, click **Yes** to continue.
9. Click **Apply**.
10. Restart PixInsight when prompted.

Future updates can be installed directly through the PixInsight Update System.

---

## Manual Installation

1. Download the latest release ZIP file.
2. Extract the archive.
3. Open PixInsight.
4. Select **Script → Feature Scripts**.
5. Click **Add**.
6. Browse to:

```text
src/scripts/PhotonDumpsterFire
```

7. Click **OK**.
8. Restart PixInsight.

---

# Included Scripts

## GradientInspector

Analyze gradients and illumination issues across multiple images at one time.

## StretchInspector

Evaluate stretch quality and histogram distribution between multiple images using different stretch methods.

## ProcessContainerPlus

Enhanced process container workflow management.

## NarrowbandPaletteBlender

Blend SHO, HOO, and custom narrowband palettes.

## IterativeStretch

Adaptive multi-pass stretch engine for astrophotography data.

## ExoplanetInspector

Currently under development. Find exoplanet hosting stars from your image and generate light curves.

---

# Repository

GitHub Repository:

https://github.com/brannonq/PhotonDumpsterFire

PixInsight Update Repository:

```text
https://raw.githubusercontent.com/brannonq/PhotonDumpsterFire/main/
```

---

# License

MIT License.

---

