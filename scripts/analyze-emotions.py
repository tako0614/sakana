#!/usr/bin/env python3
import json
import os
import sys

import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer


MODEL_NAME = os.environ.get("EMOTION_MODEL_NAME", "neuralnaut/deberta-wrime-emotions")
MAX_LENGTH = int(os.environ.get("EMOTION_MAX_LENGTH", "128"))
LABELS = ["joy", "sadness", "anticipation", "surprise", "anger", "fear", "disgust", "trust"]


def main():
    payload = json.load(sys.stdin)
    text = payload.get("text", "").strip()

    if not text:
        raise ValueError("text is required")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME)
    model.eval()

    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=MAX_LENGTH)

    with torch.no_grad():
        outputs = model(**inputs)

    scores = outputs.logits.cpu().numpy()[0]
    scores = np.clip(scores * 3.0, 0.0, 3.0)

    emotions = [
        {
            "label": label,
            "score": round(float(score), 4),
            "normalizedScore": round(float(score / 3.0), 4),
        }
        for label, score in zip(LABELS, scores)
    ]

    print(
        json.dumps(
            {
                "model": MODEL_NAME,
                "scale": "0-3",
                "emotions": emotions,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
