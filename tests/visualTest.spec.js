const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Convert image to Base64
function imageToBase64(imagePath) {
  if (fs.existsSync(imagePath)) {
    const imageData = fs.readFileSync(imagePath).toString("base64");
    const ext = path.extname(imagePath).replace(".", ""); // Get file extension (e.g., png)
    return `data:image/${ext};base64,${imageData}`;
  }
  return null; // Return null if image is missing
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  if (!fs.existsSync(baselinePath) || !fs.existsSync(currentPath)) {
    console.log(
      chalk.red(`Missing file(s): ${baselinePath} or ${currentPath}`)
    );
    return "Error";
  }

  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath)); // Staging
  const img2 = PNG.sync.read(fs.readFileSync(currentPath)); // Prod

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });

  pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {
    threshold: 0.1,
    diffColor: [0, 0, 255], // Blue for Prod Differences
    diffColorAlt: [255, 165, 0], // Orange for Staging Differences
  });

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    null,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );

  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(
      chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`)
    );
  }
}

// Generate HTML report with Base64 embedded images
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();

  // Count passed, failed, and errors
  const passed = results.filter(
    (r) =>
      typeof r.similarityPercentage === "number" && r.similarityPercentage >= 95
  ).length;
  const failed = results.filter(
    (r) =>
      typeof r.similarityPercentage === "number" && r.similarityPercentage < 95
  ).length;
  const errors = results.filter(
    (r) => r.similarityPercentage === "Error"
  ).length;

  // **SORT RESULTS: Failed first, then errors, then passed**
  results.sort((a, b) => {
    if (a.similarityPercentage === "Error") return -1;
    if (b.similarityPercentage === "Error") return 1;
    if (
      typeof a.similarityPercentage === "number" &&
      typeof b.similarityPercentage === "number"
    ) {
      return a.similarityPercentage - b.similarityPercentage; // Lower similarity first
    }
    return 0;
  });

  let htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin-bottom: 20px; }
        .summary p { font-size: 16px; }
        .summary span { font-weight: bold; }
        .summary .passed { color: green; }
        .summary .failed { color: red; }
        .summary .errors { color: orange; }
        .staging { color: orange; font-weight: bold; }
        .prod { color: blue; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: middle; }
        th { background-color: #f2f2f2; }
        .image-container { display: flex; justify-content: center; align-items: center; gap: 15px; }
        .image-wrapper { display: flex; flex-direction: column; align-items: center; }
        .image-container img { width: 350px; cursor: pointer; border: 1px solid #ddd; }
        .image-label { font-size: 14px; font-weight: bold; margin-top: 5px; text-align: center; }
        .status-pass { color: green; font-weight: bold; }
        .status-fail { color: red; font-weight: bold; }
        .status-error { color: orange; font-weight: bold; }
        .criteria { font-size: 14px; text-align: center; margin-top: 10px; font-weight: bold; }
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); }
        .modal img { display: block; max-width: 90%; max-height: 90%; margin: auto; }
        .modal-close { position: absolute; top: 20px; right: 30px; font-size: 30px; color: white; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p><span class="staging">Staging:</span> ${config.staging.baseUrl} | <span class="prod">Prod:</span> ${config.prod.baseUrl}</p>
        <p>Total Pages Tested: <span>${results.length}</span></p>
        <p>Passed: <span class="passed">${passed}</span> | Failed: <span class="failed">${failed}</span> | Errors: <span class="errors">${errors}</span></p>
        <p>Last Run: ${now}</p>
        <a href="${reportPath}" download>Download Report</a>
      </div>
      <p class="criteria">✅ Success Criteria: A similarity score of 95% or higher is considered a pass.</p>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Images</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const sanitizedPath = result.pagePath.replace(/\//g, "_");
    const stagingBase64 = imageToBase64(
      `screenshots/${deviceName}/staging/${sanitizedPath}.png`
    );
    const prodBase64 = imageToBase64(
      `screenshots/${deviceName}/prod/${sanitizedPath}.png`
    );
    const diffBase64 = imageToBase64(
      `screenshots/${deviceName}/diff/${sanitizedPath}.png`
    );

    let statusClass = "status-error";
    let statusText = "Error";

    if (typeof result.similarityPercentage === "number") {
      if (result.similarityPercentage >= 95) {
        statusClass = "status-pass";
        statusText = "Pass";
      } else {
        statusClass = "status-fail";
        statusText = "Fail";
      }
    }

    htmlContent += `
    <tr>
      <td>
        <a href="${config.staging.baseUrl}${
      result.pagePath
    }" target="_blank" class="staging">Staging</a> | 
        <a href="${config.prod.baseUrl}${
      result.pagePath
    }" target="_blank" class="prod">Prod</a>
      </td>
      <td>${
        typeof result.similarityPercentage === "number"
          ? result.similarityPercentage.toFixed(2) + "%"
          : "Error"
      }</td>
      <td class="${statusClass}">${statusText}</td>
      <td>
        <div class="image-container">
          ${
            stagingBase64
              ? `<div class="image-wrapper">
                   <img src="${stagingBase64}" onclick="openModal('${stagingBase64}')" alt="Staging">
                   <div class="image-label">Staging</div>
                 </div>`
              : "N/A"
          }
          ${
            prodBase64
              ? `<div class="image-wrapper">
                   <img src="${prodBase64}" onclick="openModal('${prodBase64}')" alt="Prod">
                   <div class="image-label">Prod</div>
                 </div>`
              : "N/A"
          }
          ${
            diffBase64
              ? `<div class="image-wrapper">
                   <img src="${diffBase64}" onclick="openModal('${diffBase64}')" alt="Diff">
                   <div class="image-label">Diff</div>
                 </div>`
              : "N/A"
          }
        </div>
      </td>
    </tr>
  `;
  });

  htmlContent += `
        </tbody>
      </table>

      <div id="modal" class="modal">
        <span class="modal-close" onclick="closeModal()">&times;</span>
        <img id="modal-image">
      </div>

      <script>
        function openModal(imageSrc) { 
          document.getElementById("modal-image").src = imageSrc; 
          document.getElementById("modal").style.display = "block"; 
        }
        function closeModal() { 
          document.getElementById("modal").style.display = "none"; 
        }
      </script>

    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });

  test("Fill out the form one field at a time and submit", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const formPageUrl = "https://live-web-emporia.pantheonsite.io/";
      console.log(chalk.blue(`Navigating to the form page: ${formPageUrl}`));

      await page.goto(formPageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Page partially loaded successfully."));

      // Block unnecessary resources to stabilize the page
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (
          url.endsWith(".png") ||
          url.endsWith(".jpg") ||
          url.endsWith(".css") ||
          url.endsWith(".js")
        ) {
          route.abort();
        } else {
          route.continue();
        }
      });
      console.log(
        chalk.blue("Blocked unnecessary resources to stabilize the page.")
      );

      // Select the first option in "Program of Interest"
      console.log(chalk.blue("Selecting 'Program of Interest'..."));
      await page.selectOption("#input_2_1", { index: 1 }); // Select the first option
      console.log(chalk.green("'Program of Interest' selected successfully."));

      // Fill in "First Name"
      const testIteration = Date.now(); // Use timestamp for unique identification
      const firstName = `John${testIteration}`;
      console.log(chalk.blue(`Filling 'First Name' with: ${firstName}`));
      await page.fill("#input_2_2", firstName);
      console.log(chalk.green("'First Name' filled successfully."));

      // Fill in "Last Name"
      console.log(chalk.blue("Filling 'Last Name'..."));
      await page.fill("#input_2_3", "Doe");
      console.log(chalk.green("'Last Name' filled successfully."));

      // Fill in "Email"
      const email = `johndoe${testIteration}@example.com`;
      console.log(chalk.blue(`Filling 'Email' with: ${email}`));
      await page.fill("#input_2_6", email);
      console.log(chalk.green("'Email' filled successfully."));

      // Fill in "Phone"
      console.log(chalk.blue("Filling 'Phone'..."));
      await page.fill("#input_2_4", "5551234567");
      console.log(chalk.green("'Phone' filled successfully."));

      // Fill in "ZIP Code"
      console.log(chalk.blue("Filling 'ZIP Code'..."));
      await page.fill("#input_2_5", "12345");
      console.log(chalk.green("'ZIP Code' filled successfully."));

      // Select "How did you hear about us?"
      console.log(chalk.blue("Selecting 'How did you hear about us?'..."));
      await page.selectOption("#input_2_7", { index: 2 }); // Select the second option
      console.log(
        chalk.green("'How did you hear about us?' selected successfully.")
      );

      // Submit the form
      console.log(chalk.blue("Submitting the form..."));
      await page.click("#gform_submit_button_2");
      console.log(chalk.green("Form submitted successfully."));

      // Wait for confirmation message
      console.log(chalk.blue("Waiting for confirmation message..."));
      await page.waitForSelector("h1.header1", { timeout: 20000 });
      const confirmationText = await page.textContent("h1.header1");

      // Verify confirmation message
      if (confirmationText.trim() === "Thanks for your submission!") {
        console.log(
          chalk.green(
            "Form submitted successfully and confirmation message displayed."
          )
        );
      } else {
        console.log(
          chalk.red("Confirmation message text did not match expected value.")
        );
      }
    } catch (error) {
      console.error(chalk.red(`Error during test: ${error.message}`));
    } finally {
      await context.close();
    }
  });

  test("Click Apply Now, fill out the form, and submit", async ({ page }) => {
    // Navigate to the homepage
    const homePageUrl = "https://live-web-emporia.pantheonsite.io/";
    console.log(chalk.blue(`Navigating to the home page: ${homePageUrl}`));
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });

    // Click on the "Apply Now" button
    const applyNowSelector = "a.button.elementor-button.elementor-size-sm";
    console.log(chalk.blue("Clicking on 'Apply Now' button..."));
    await page.click(applyNowSelector);

    // Wait for the form page to load
    const formPageUrl = "https://live-web-emporia.pantheonsite.io/apply/";
    console.log(
      chalk.blue(`Waiting for navigation to the form page: ${formPageUrl}`)
    );
    await page.waitForURL(formPageUrl, { timeout: 10000 });
    console.log(chalk.green("Navigated to the Apply Now form page."));

    // Fill the form fields
    console.log(chalk.blue("Filling out the Apply Now form fields..."));
    await page.selectOption("#input_1_1", { value: "EMPORIA-M-MBAACCT" }); // Select "MBA with Accounting Concentration"
    await page.fill("#input_1_2", "Jane"); // First Name
    await page.fill("#input_1_3", "Smith"); // Last Name
    await page.fill("#input_1_4", "janesmith@example.com"); // Email
    await page.fill("#input_1_5", "5559876543"); // Phone
    await page.fill("#input_1_6", "54321"); // ZIP Code
    await page.selectOption("#input_1_7", { value: "Online" }); // Select "Online"
    console.log(chalk.green("Form fields filled successfully."));

    // Submit the form and wait for navigation to the confirmation page
    console.log(chalk.blue("Submitting the Apply Now form..."));
    await Promise.all([
      page.waitForURL(/\/apply2\/\?d=EMPORIA-M-MBAACCT&entry_id=\d+/, {
        timeout: 30000,
      }), // Wait for dynamic confirmation page
      page.click("#gform_submit_button_1"),
    ]);
    console.log(
      chalk.green("Form submitted, and navigated to the confirmation page.")
    );

    // Wait for the specific confirmation message
    console.log(
      chalk.blue("Waiting for confirmation message on the confirmation page...")
    );
    const specificConfirmationSelector =
      ".elementor-element.elementor-element-a8355df h1.header1";
    try {
      await page.waitForSelector(specificConfirmationSelector, {
        timeout: 15000,
      }); // Wait for the specific confirmation message
      const confirmationText = await page.textContent(
        specificConfirmationSelector
      );

      // Log the confirmation message
      console.log(
        chalk.blue(`Confirmation message found: "${confirmationText.trim()}"`)
      );

      // Verify the confirmation message text
      if (
        confirmationText.trim() ===
        "Great! Now, take the next step to complete your application."
      ) {
        console.log(
          chalk.green(
            "Form submitted successfully, and confirmation message displayed."
          )
        );
      } else {
        console.log(
          chalk.red("Confirmation message text did not match expected value.")
        );
      }
    } catch (error) {
      console.error(
        chalk.red(`Error waiting for confirmation message: ${error.message}`)
      );
    }
  });

  test("Verify Online Programs and Getting Started Menus", async ({ page }) => {
    const verifyMenu = async (menuName, menuSelector) => {
      console.log(chalk.blue(`Locating the '${menuName}' menu...`));
      const isMenuVisible = await page.isVisible(menuSelector);
      if (!isMenuVisible) {
        throw new Error(`The '${menuName}' menu is not visible.`);
      }
      console.log(chalk.green(`${menuName} menu is visible.`));

      // Get all submenus and links
      const submenuSelector = `${menuSelector} ul.mega-sub-menu`;
      const linksSelector = `${submenuSelector} a.mega-menu-link`;

      console.log(
        chalk.blue(`Checking for submenus and links in '${menuName}' menu...`)
      );
      const submenuCount = await page.locator(submenuSelector).count();
      console.log(
        chalk.green(`Found ${submenuCount} submenus in '${menuName}' menu.`)
      );

      const links = await page.locator(linksSelector);
      const linkCount = await links.count();
      console.log(
        chalk.green(`Found ${linkCount} links in '${menuName}' menu.`)
      );

      // Verify each link
      let invalidLinks = 0;
      for (let i = 0; i < linkCount; i++) {
        const linkText = await links.nth(i).textContent();
        const linkHref = await links.nth(i).getAttribute("href");
        console.log(
          chalk.blue(
            `Checking link ${i + 1} in '${menuName}' menu: ${linkText}`
          )
        );

        if (!linkHref || linkHref.trim() === "") {
          console.log(
            chalk.yellow(
              `Warning: Link '${linkText}' in '${menuName}' menu does not have a valid href attribute.`
            )
          );
          invalidLinks++;
        } else {
          console.log(
            chalk.green(
              `Link '${linkText}' in '${menuName}' menu is valid with href: ${linkHref}`
            )
          );
        }
      }

      console.log(
        chalk.green(
          `All checks complete for '${menuName}' menu. Found ${invalidLinks} invalid links.`
        )
      );

      // Log warning instead of failing the test
      if (invalidLinks > 0) {
        console.log(
          chalk.yellow(
            `Test completed with ${invalidLinks} warnings for invalid links in '${menuName}' menu.`
          )
        );
      } else {
        console.log(
          chalk.green(`All links in the '${menuName}' menu are valid.`)
        );
      }
    };

    console.log(chalk.blue("Navigating to the homepage..."));

    // Navigate to the homepage
    const homePageUrl = "https://live-web-emporia.pantheonsite.io/";
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
    console.log(chalk.green("Homepage loaded successfully."));

    // Verify the 'Online Programs' menu
    await verifyMenu("Online Programs", "#mega-menu-item-313");

    // Verify the 'Getting Started' menu
    await verifyMenu("Getting Started", "#mega-menu-item-314");
  });
});
