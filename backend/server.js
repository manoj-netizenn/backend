const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const helmet = require("helmet");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);

app.use(cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }));

app.use(bodyParser.json({ limit: "10mb" }));

// IMPORTANT: This MUST match EXACTLY what's in Google Cloud Console
// Copy and paste the exact URL from Google Cloud Console here
const REDIRECT_URI = process.env.REDIRECT_URI;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token is required" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
};

app.post("/api/auth/google", async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: "Google access token is required" });
    }

    const userInfoResponse = await axios.get(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const userInfo = userInfoResponse.data;

    const user = {
      googleId: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
    };

    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "1h" });

    res.status(200).json({
      token,
      user,
    });
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({
      error: "Authentication failed",
      details: error.message,
    });
  }
});

app.post("/api/auth/refresh", authenticateToken, (req, res) => {
  const token = jwt.sign(req.user, JWT_SECRET, { expiresIn: "1h" });
  res.status(200).json({ token });
});

const drive = google.drive({
  version: "v3",
  auth: oauth2Client,
});

const docs = google.docs({
  version: "v1",
  auth: oauth2Client,
});

app.post("/api/save-to-drive", authenticateToken, async (req, res) => {
  try {
    const { title, content, accessToken } = req.body;

    if (!accessToken) {
      return res.status(401).json({ error: "No Google access token provided" });
    }

    oauth2Client.setCredentials({ access_token: accessToken });

    const docResponse = await docs.documents.create({
      requestBody: {
        title: title || "Untitled Document",
      },
    });

    const documentId = docResponse.data.documentId;

    const formattedContent = await convertHtmlToGoogleDocsFormat(content);

    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: formattedContent,
      },
    });
    res.status(200).json({
      success: true,
      documentId,
      documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
    });
  } catch (error) {
    console.error("Error saving to Google Drive:", error);
    res.status(500).json({
      error: "Failed to save document to Google Drive",
      details: error.message,
    });
  }
});

app.get("/api/get-documents", authenticateToken, async (req, res) => {
  try {
    const { accessToken } = req.query;

    if (!accessToken) {
      return res.status(401).json({ error: "No Google access token provided" });
    }

    oauth2Client.setCredentials({ access_token: accessToken });

    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.document'",
      fields: "files(id, name, webViewLink, createdTime, modifiedTime)",
      orderBy: "modifiedTime desc",
    });

    res.status(200).json({
      success: true,
      documents: response.data.files,
    });
  } catch (error) {
    console.error("Error fetching documents:", error);
    res.status(500).json({
      error: "Failed to fetch documents from Google Drive",
      details: error.message,
    });
  }
});

async function convertHtmlToGoogleDocsFormat(html) {
  html = html.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    ""
  );

  const requests = [];
  let currentIndex = 1; // Start at index 1 (after the title)

  const paragraphs = html.split(/<\/?p[^>]*>/i).filter((p) => p.trim());

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;

    if (paragraph.includes("<h1>") || paragraph.includes("</h1>")) {
      const text = paragraph.replace(/<\/?h1[^>]*>/gi, "").trim();
      requests.push({
        insertText: {
          location: { index: currentIndex },
          text: text + "\n",
        },
      });

      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: currentIndex,
            endIndex: currentIndex + text.length,
          },
          paragraphStyle: {
            namedStyleType: "HEADING_1",
          },
          fields: "namedStyleType",
        },
      });

      currentIndex += text.length + 1; // +1 for the newline
    } else if (paragraph.includes("<h2>") || paragraph.includes("</h2>")) {
      const text = paragraph.replace(/<\/?h2[^>]*>/gi, "").trim();
      requests.push({
        insertText: {
          location: { index: currentIndex },
          text: text + "\n",
        },
      });

      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: currentIndex,
            endIndex: currentIndex + text.length,
          },
          paragraphStyle: {
            namedStyleType: "HEADING_2",
          },
          fields: "namedStyleType",
        },
      });

      currentIndex += text.length + 1;
    } else {
      let text = paragraph
        .replace(/<\/?[^>]+(>|$)/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();

      requests.push({
        insertText: {
          location: { index: currentIndex },
          text: text + "\n",
        },
      });

      currentIndex += text.length + 1;
    }
  }

  return requests;
}

app.get("/api/user/profile", authenticateToken, (req, res) => {
  res.status(200).json({ user: req.user });
});

app.post("/api/auth/logout", authenticateToken, (req, res) => {
  res.status(200).json({ message: "Logged out successfully" });
});

app.get("/api/auth/google/url", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/documents",
    ],
    prompt: "consent",
  });

  res.json({ url: authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;

    const { tokens } = await oauth2Client.getToken(code);

    res.redirect(
      `${process.env.FRONTEND_URL}/auth-callback?token=${tokens.access_token}`
    );
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/auth-error`);
  } //|| "http://localhost:3000"
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
