import express from "express";
import axios from "axios";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CONFIG FROM ENV ======
const CHANNEL_ID = process.env.CHANNEL_ID;
const CALLBACK_BASE_URL = process.env.CALLBACK_BASE_URL;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const HUB_SECRET = process.env.HUB_SECRET || "";

// ====== FIXED URLS ======
const HUB_SUBSCRIBE_URL = "https://pubsubhubbub.appspot.com/subscribe";
const CALLBACK_PATH = "/webhooks/youtube";
const CALLBACK_URL = `${CALLBACK_BASE_URL}${CALLBACK_PATH}`;
const TOPIC_URL = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

// Keep raw XML body
app.use(
  express.text({
    type: ["application/atom+xml", "application/xml", "text/xml", "*/*"],
  })
);

// Very simple duplicate protection while app is running.
// If the app restarts, this memory is cleared.
const seenVideoIds = new Set();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

function mustHaveEnv(name, value) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

function verifyHubSignature(rawBody, signatureHeader) {
  if (!HUB_SECRET) return true;
  if (!signatureHeader) return false;

  const [algo, incomingSig] = signatureHeader.split("=");
  if (algo !== "sha1" || !incomingSig) return false;

  const expectedSig = crypto
    .createHmac("sha1", HUB_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(incomingSig, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch {
    return false;
  }
}

async function sendEmail({ title, videoId, link, author, published, updated }) {
  const subject = `New YouTube upload: ${title}`;

  const text = [
    `Channel: ${author}`,
    `Title: ${title}`,
    `Video ID: ${videoId}`,
    `Published: ${published}`,
    `Updated: ${updated}`,
    `Watch: ${link}`
  ].join("\n");

  const html = `
    <h2>New YouTube upload</h2>
    <p><strong>Channel:</strong> ${author}</p>
    <p><strong>Title:</strong> ${title}</p>
    <p><strong>Video ID:</strong> ${videoId}</p>
    <p><strong>Published:</strong> ${published}</p>
    <p><strong>Updated:</strong> ${updated}</p>
    <p><a href="${link}">Watch the video</a></p>
  `;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text,
    html,
  });
}

async function subscribeToYouTube() {
  const form = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": TOPIC_URL,
    "hub.callback": CALLBACK_URL,
    "hub.verify": "async",
  });

  if (HUB_SECRET) {
    form.set("hub.secret", HUB_SECRET);
  }

  const response = await axios.post(HUB_SUBSCRIBE_URL, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  return {
    status: response.status,
    data: response.data,
  };
}

// ====== ROUTES ======
app.get("/", (_req, res) => {
  res.status(200).send("YouTube webhook app is running.");
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    channelId: CHANNEL_ID,
    callbackUrl: CALLBACK_URL,
    topicUrl: TOPIC_URL,
  });
});

// WebSub verification
app.get(CALLBACK_PATH, (req, res) => {
  const challenge = req.query["hub.challenge"];
  const mode = req.query["hub.mode"];
  const topic = req.query["hub.topic"];

  console.log("Verification request received:", { mode, topic });

  if (!challenge) {
    return res.status(400).send("Missing hub.challenge");
  }

  return res.status(200).send(String(challenge));
});

// Actual notification receiver
app.post(CALLBACK_PATH, async (req, res) => {
  try {
    const rawXml = req.body || "";

    const signature = req.header("x-hub-signature");
    if (!verifyHubSignature(rawXml, signature)) {
      console.error("Invalid signature");
      return res.status(401).send("Invalid signature");
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
    });

    const parsed = parser.parse(rawXml);
    const entry = parsed?.feed?.entry;

    // Sometimes the payload may not contain an entry
    if (!entry) {
      console.log("Notification received without entry");
      return res.status(204).send();
    }

    const videoId = entry["yt:videoId"];
    const channelId = entry["yt:channelId"];
    const title = entry.title || "Untitled video";
    const published = entry.published || "";
    const updated = entry.updated || "";
    const author = entry.author?.name || "Unknown channel";

    let link = `https://www.youtube.com/watch?v=${videoId}`;
    if (entry.link?.href) link = entry.link.href;
    if (entry.link?.["@_href"]) link = entry.link["@_href"];

    console.log("Notification received:", {
      channelId,
      videoId,
      title,
      published,
      updated,
    });

    // Deduplicate during current app runtime
    if (seenVideoIds.has(videoId)) {
      console.log("Skipping duplicate video:", videoId);
      return res.status(204).send();
    }

    seenVideoIds.add(videoId);

    await sendEmail({
      title,
      videoId,
      link,
      author,
      published,
      updated,
    });

    console.log("Email sent for video:", videoId);
    return res.status(204).send();
  } catch (error) {
    console.error("Error handling webhook:", error?.message || error);
    return res.status(500).send("Internal Server Error");
  }
});

// Manual subscribe route
app.get("/subscribe-now", async (_req, res) => {
  try {
    const result = await subscribeToYouTube();
    res.status(200).json({
      ok: true,
      topic: TOPIC_URL,
      callback: CALLBACK_URL,
      subscribeResult: result,
    });
  } catch (error) {
    console.error("Subscription failed:", error?.message || error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

async function start() {
  mustHaveEnv("CHANNEL_ID", CHANNEL_ID);
  mustHaveEnv("CALLBACK_BASE_URL", CALLBACK_BASE_URL);
  mustHaveEnv("EMAIL_FROM", EMAIL_FROM);
  mustHaveEnv("EMAIL_TO", EMAIL_TO);
  mustHaveEnv("GMAIL_USER", GMAIL_USER);
  mustHaveEnv("GMAIL_APP_PASSWORD", GMAIL_APP_PASSWORD);

  app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Topic URL: ${TOPIC_URL}`);
    console.log(`Callback URL: ${CALLBACK_URL}`);

    try {
      const result = await subscribeToYouTube();
      console.log("Initial subscribe response:", result);
    } catch (error) {
      console.error("Initial subscribe failed:", error?.message || error);
    }
  });
}

start();
