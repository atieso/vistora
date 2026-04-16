import express from "express";
import cors from "cors";

const app = express();

app.use(cors());

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Vistora Google Reviews Proxy" });
}); 

app.get("/debug-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";

  res.json({
    hasKey: !!key,
    keyPrefix: key ? key.slice(0, 6) : null
  });
});

app.get("/google-reviews", async (req, res) => {
  const placeId = req.query.place_id;

  if (!placeId) {
    return res.status(400).json({ error: "Missing place_id" });
  }

  try {
    const googleUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;

    const googleRes = await fetch(googleUrl, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "displayName,rating,userRatingCount,reviews"
      }
    });

    const rawText = await googleRes.text();

    if (!googleRes.ok) {
      return res.status(googleRes.status).json({
        error: "Google API error",
        details: rawText
      });
    }

    const place = JSON.parse(rawText);

    const payload = {
      name: place?.displayName?.text || "",
      rating: place?.rating || null,
      userRatingCount: place?.userRatingCount || 0,
      reviews: Array.isArray(place?.reviews)
        ? place.reviews.slice(0, 5).map((review) => ({
            author: review?.authorAttribution?.displayName || "Utente Google",
            rating: review?.rating || 5,
            text: review?.originalText?.text || review?.text?.text || "",
            relativeTimeDescription: review?.relativePublishTimeDescription || ""
          }))
        : []
    };

    res.set("Cache-Control", "public, max-age=1800");
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: String(error)
    });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
