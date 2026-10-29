#!/usr/bin/env node
/**
 * Seeds the real MIT 15.773 course into Supabase:
 *   - 11 YouTube lectures with WebVTT transcripts
 *   - 14 lecture-note PDFs, chunked with page locators
 *   - the course syllabus as a course-level Markdown resource
 *   - Jina embeddings stored with an explicit model/version space
 *
 * Required local-only credentials in .env:
 *   SUPABASE_URL, SUPABASE_ACCESS_TOKEN (to read the server key once)
 *   JINA_API_KEY
 *
 * The service-role key is retrieved in memory and never written or logged.
 * Only the demo course owned by this script is replaced.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  chunkText,
  extractPdf,
  formatTimestamp,
  mergeTranscript,
  normalizeText,
  parseVtt,
  sha256,
  stripHtml,
} from "./lib/content.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const COURSE_ID = "mit-15-773";
const JINA_MODEL = "jina-embeddings-v3";
const JINA_DIMENSION = 1_024;
const JINA_VERSION = "2024-09-v3-1024";
const JINA_SPACE = `jina:${JINA_MODEL}:${JINA_DIMENSION}:${JINA_VERSION}`;
const EMBED_BATCH_SIZE = 32;
const INSERT_BATCH_SIZE = 40;
const DRY_RUN = process.argv.includes("--dry-run");

const SUPABASE_URL = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const ACCESS_TOKEN = requiredEnv("SUPABASE_ACCESS_TOKEN");
const JINA_API_KEY = requiredEnv("JINA_API_KEY");
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in the server environment.`);
  return value;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`Ingestion failed: ${message}\n`);
  process.exit(1);
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), "utf8"));
}

async function getServiceRoleKey() {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`,
    { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
  );
  if (!response.ok) fail(`Management API could not read project keys (HTTP ${response.status}).`);
  const keys = await response.json();
  const key = keys.find(
    (entry) => entry.name === "service_role" || (entry.type === "secret" && entry.api_key),
  );
  if (!key?.api_key) fail("No server key is available for this Supabase project.");
  return key.api_key;
}

function restHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function rest(serviceKey, pathname, init = {}) {
  const countOnly = init.prefer === "count";
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: restHeaders(serviceKey, {
      ...init.headers,
      ...(countOnly ? { Prefer: "count=exact" } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    fail(
      `${init.method ?? "GET"} ${pathname} returned HTTP ${response.status}: ${body.slice(0, 280)}`,
    );
  }
  if (countOnly) return response;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function insertRows(
  serviceKey,
  table,
  rows,
  batchSize = INSERT_BATCH_SIZE,
  { upsert = false } = {},
) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await rest(serviceKey, table, {
      method: "POST",
      headers: {
        prefer: upsert ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
      },
      body: JSON.stringify(batch),
    });
    log(`  inserted ${Math.min(start + batch.length, rows.length)}/${rows.length} ${table}`);
  }
}

function cleanTitle(value) {
  return String(value ?? "")
    .replace(/\uFFFD/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function lectureNumberFromVtt(file) {
  return Number(file.match(/lecture-(\d+)-version/i)?.[1] ?? 0);
}

function lectureNumberFromPdf(file) {
  if (/lec105/i.test(file)) return 10;
  return Number(file.match(/lec(\d{1,2})/i)?.[1] ?? 0);
}

function notesTitle(lectureNumber, file) {
  if (/backprop/i.test(file)) return `Lecture ${lectureNumber} worked example: backpropagation`;
  if (/lec03a/i.test(file)) return `Lecture ${lectureNumber} notes, part A`;
  if (/lec03b/i.test(file)) return `Lecture ${lectureNumber} notes, part B`;
  if (/lec105/i.test(file)) return `Lecture ${lectureNumber} notes, additional examples`;
  return `Lecture ${lectureNumber} notes`;
}

function youtubeDescription(video, lectureNumber) {
  const raw = String(video.video_metadata?.youtube_description ?? "");
  const body = stripHtml(raw)
    .split(/\n{2,}/)
    .slice(1)
    .join("\n\n")
    .trim();
  return (
    body.slice(0, 700) ||
    `MIT 15.773 Hands-On Deep Learning, Spring 2024. Lecture ${lectureNumber}.`
  );
}

function transcriptResource({ courseId, lessonId, lectureNumber, youtubeId, segments, title }) {
  const resourceId = randomUUID();
  const text = segments.map((segment) => segment.text).join("\n\n");
  return {
    resource: {
      id: resourceId,
      owner_id: null,
      course_id: courseId,
      lesson_id: lessonId,
      is_demo: true,
      kind: "video_transcript",
      title,
      status: "ready",
      source_url: `https://www.youtube.com/watch?v=${youtubeId}`,
      content_hash: sha256(text),
      metadata: {
        source: "MIT OpenCourseWare 15.773 Spring 2024",
        youtubeId,
        lecture: lectureNumber,
        segmentCount: segments.length,
        license: "CC BY-NC-SA 4.0",
      },
    },
    chunks: segments.map((segment, index) => ({
      resource_id: resourceId,
      chunk_index: index,
      heading: null,
      text: segment.text,
      locator_kind: "video",
      video_start_seconds: Number(segment.start.toFixed(3)),
      video_end_seconds: Number(segment.end.toFixed(3)),
      page_number: null,
      slide_number: null,
      section: null,
      content_hash: sha256(segment.text),
      metadata: { lecture: lectureNumber, youtubeId },
    })),
  };
}

async function pdfResource({ courseId, lessonId, lectureNumber, file, publicFile }) {
  const absolute = path.join(ROOT, "static_resources", file);
  const extracted = await extractPdf(absolute);
  const chunks = [];
  for (const page of extracted.pages) {
    if (page.text.length < 30) continue;
    const passages = chunkText(page.text, { targetChars: 850, maxChars: 1_400 });
    passages.forEach((text, index) => {
      chunks.push({
        chunk_index: chunks.length,
        heading: `Page ${page.pageNumber}${passages.length > 1 ? `, part ${index + 1}` : ""}`,
        text,
        locator_kind: "page",
        video_start_seconds: null,
        video_end_seconds: null,
        page_number: page.pageNumber,
        slide_number: null,
        section: null,
        content_hash: sha256(text),
        metadata: { lecture: lectureNumber, file, part: index + 1 },
      });
    });
  }
  const resource = {
    id: randomUUID(),
    owner_id: null,
    course_id: courseId,
    lesson_id: lessonId,
    is_demo: true,
    kind: "pdf",
    title: notesTitle(lectureNumber, file),
    status: "ready",
    source_url: `/course/mit-15-773/${publicFile}`,
    content_hash: sha256(`${file}:${extracted.pageCount}:${chunks.length}`),
    metadata: {
      source: "MIT OpenCourseWare 15.773 Spring 2024",
      file,
      lecture: lectureNumber,
      pageCount: extracted.pageCount,
      license: "CC BY-NC-SA 4.0",
    },
  };
  const withResource = chunks.map((chunk) => ({ ...chunk, resource_id: resource.id }));
  return { resource, chunks: withResource, pageCount: extracted.pageCount };
}

function markdownResource({ courseId, text, sourceUrl, title }) {
  const resourceId = randomUUID();
  const chunks = chunkText(text, { targetChars: 900, maxChars: 1_500 }).map((chunk, index) => ({
    resource_id: resourceId,
    chunk_index: index,
    heading: null,
    text: chunk,
    locator_kind: "text",
    video_start_seconds: null,
    video_end_seconds: null,
    page_number: null,
    slide_number: null,
    section: `Syllabus part ${index + 1}`,
    content_hash: sha256(chunk),
    metadata: { source: "MIT OCW syllabus" },
  }));
  return {
    resource: {
      id: resourceId,
      owner_id: null,
      course_id: courseId,
      lesson_id: null,
      is_demo: true,
      kind: "markdown",
      title,
      status: "ready",
      source_url: sourceUrl,
      content_hash: sha256(text),
      metadata: { source: "MIT OpenCourseWare 15.773 Spring 2024", license: "CC BY-NC-SA 4.0" },
    },
    chunks,
  };
}

async function embedChunks(chunks) {
  if (!chunks.length) return;
  log(`Generating Jina embeddings for ${chunks.length} passages...`);
  for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await fetch("https://api.jina.ai/v1/embeddings", {
          method: "POST",
          signal: AbortSignal.timeout(90_000),
          headers: {
            authorization: `Bearer ${JINA_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: JINA_MODEL,
            input: batch.map((chunk) => chunk.text),
            dimensions: JINA_DIMENSION,
            task: "retrieval.passage",
            normalized: true,
          }),
        });
      } catch (error) {
        if (attempt >= 4) fail(`Jina network error: ${error.name}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 5) fail(`Jina remained unavailable (HTTP ${response.status}).`);
        const retryAfter = Number(response.headers.get("retry-after"));
        await new Promise((resolve) =>
          setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 2_500 * attempt),
        );
        continue;
      }
      if (!response.ok) {
        fail(`Jina rejected embeddings (HTTP ${response.status}). Check JINA_API_KEY and quota.`);
      }
      const payload = await response.json();
      const rows = Array.isArray(payload.data) ? [...payload.data] : [];
      rows.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      if (rows.length !== batch.length) fail("Jina returned an unexpected number of vectors.");
      rows.forEach((row, index) => {
        const vector = row.embedding;
        if (!Array.isArray(vector) || vector.length !== JINA_DIMENSION) {
          fail("Jina returned an incompatible embedding dimension.");
        }
        const chunk = batch[index];
        chunk.embedding = `[${vector.join(",")}]`;
        chunk.embedding_space_key = JINA_SPACE;
        chunk.embedding_provider = "jina";
        chunk.embedding_model = JINA_MODEL;
        chunk.embedding_dimension = JINA_DIMENSION;
        chunk.embedding_version = JINA_VERSION;
      });
      break;
    }
    if ((start / EMBED_BATCH_SIZE + 1) % 10 === 0 || start + batch.length >= chunks.length) {
      log(`  embedded ${Math.min(start + batch.length, chunks.length)}/${chunks.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
}

async function main() {
  log("Reading local course files...");
  const gallery = await readJson("video_galleries/lecture-videos/data.json");
  const videos = Array.isArray(gallery.videos) ? gallery.videos : [];
  if (videos.length !== 11) fail(`Expected 11 MIT lectures, found ${videos.length}.`);

  const staticFiles = await fs.readdir(path.join(ROOT, "static_resources"));
  const captions = new Map();
  for (const file of staticFiles.filter((name) => name.endsWith("_captions.vtt"))) {
    const number = lectureNumberFromVtt(file);
    if (number) captions.set(number, file);
  }
  const notePdfs = staticFiles.filter((name) => /^mit15_773_s24_lec.*\.pdf$/i.test(name));
  if (captions.size !== 11) fail(`Expected 11 caption files, found ${captions.size}.`);

  const syllabusRaw = await readJson("pages/syllabus/data.json");
  const syllabusText = [
    "# MIT 15.773 Hands-On Deep Learning — syllabus and course notes",
    "",
    "Source: MIT OpenCourseWare, Spring 2024. Licensed CC BY-NC-SA 4.0.",
    "",
    stripHtml(syllabusRaw.content),
  ].join("\n");
  await fs.writeFile(path.join(ROOT, "public/course/mit-15-773/syllabus.md"), `${syllabusText}\n`);

  const lessons = [];
  const resources = [];
  const chunks = [];

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const lectureNumber = index + 1;
    const youtubeId = String(video.video_metadata?.youtube_id ?? "").trim();
    if (!youtubeId) fail(`Lecture ${lectureNumber} has no YouTube id.`);
    const captionFile = captions.get(lectureNumber);
    if (!captionFile) fail(`Lecture ${lectureNumber} has no caption file.`);
    const rawVtt = await fs.readFile(path.join(ROOT, "static_resources", captionFile), "utf8");
    const cues = parseVtt(rawVtt);
    if (!cues.length) fail(`Lecture ${lectureNumber} captions produced no usable cues.`);
    const segments = mergeTranscript(cues, {
      targetChars: 600,
      maxChars: 1_400,
      maxGapSeconds: 4,
      maxSpanSeconds: 20,
    });
    const duration = Math.max(...cues.map((cue) => cue.end));
    const lessonId = `${COURSE_ID}-${String(lectureNumber).padStart(2, "0")}`;
    const title = cleanTitle(video.title) || `Lecture ${lectureNumber}`;
    lessons.push({
      id: lessonId,
      course_id: COURSE_ID,
      user_id: null,
      title,
      description: youtubeDescription(video, lectureNumber),
      position: lectureNumber,
      duration_seconds: Number(duration.toFixed(3)),
      video_url: `https://www.youtube.com/watch?v=${youtubeId}`,
      provider: "youtube",
      transcript: segments.map((segment) => ({
        start: Number(segment.start.toFixed(3)),
        end: Number(segment.end.toFixed(3)),
        text: segment.text,
      })),
      transcript_status: "available",
      is_demo: true,
    });
    const transcript = transcriptResource({
      courseId: COURSE_ID,
      lessonId,
      lectureNumber,
      youtubeId,
      segments,
      title: `${title} — transcript`,
    });
    resources.push(transcript.resource);
    chunks.push(...transcript.chunks);
    log(
      `  lecture ${lectureNumber}: ${segments.length} transcript passages, ${formatTimestamp(duration)}`,
    );

    const matchingPdfs = notePdfs.filter((file) => lectureNumberFromPdf(file) === lectureNumber);
    for (const file of matchingPdfs) {
      const pdf = await pdfResource({
        courseId: COURSE_ID,
        lessonId,
        lectureNumber,
        file,
        publicFile: file,
      });
      resources.push(pdf.resource);
      chunks.push(...pdf.chunks);
      log(
        `  lecture ${lectureNumber}: ${pdf.pageCount} PDF pages -> ${pdf.chunks.length} passages (${file})`,
      );
    }
  }

  const syllabus = markdownResource({
    courseId: COURSE_ID,
    text: syllabusText,
    sourceUrl: "/course/mit-15-773/syllabus.md",
    title: "MIT 15.773 syllabus and course description",
  });
  resources.push(syllabus.resource);
  chunks.push(...syllabus.chunks);

  if (!resources.length || !chunks.length) fail("No indexable content was produced.");
  log(`Prepared ${resources.length} resources and ${chunks.length} passages.`);
  if (DRY_RUN) {
    const byKind = resources.reduce((counts, resource) => {
      counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
      return counts;
    }, {});
    log(`Dry run complete: ${JSON.stringify(byKind)}; no embeddings or database writes performed.`);
    return;
  }

  await embedChunks(chunks);

  log("Reading the project server key (never printed)...");
  const serviceKey = await getServiceRoleKey();

  const course = {
    id: COURSE_ID,
    title: "Hands-On Deep Learning (MIT 15.773)",
    description:
      "MIT OpenCourseWare 15.773, Spring 2024. Build neural networks from scratch, then apply them to tabular data, vision, natural language and generative AI. Includes 11 lecture transcripts and 14 lecture-note PDFs.",
    category: "Deep learning",
    objectives: [
      "Build and train neural networks from first principles",
      "Apply deep learning to tabular, image, text and generative tasks",
      "Understand embeddings, attention and transformer models",
      "Use retrieval-augmented generation with evidence and citations",
      "Adapt large language models with parameter-efficient fine-tuning",
      "Evaluate models honestly and recognize their limits",
    ],
    is_demo: true,
  };

  log("Deleting previous indexed content for this demo course...");
  await rest(serviceKey, `learning_resources?course_id=eq.${COURSE_ID}&is_demo=eq.true`, {
    method: "DELETE",
    headers: { prefer: "return=minimal" },
  });

  log("Upserting course and lessons...");
  await rest(serviceKey, "courses?on_conflict=id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([course]),
  });
  await insertRows(serviceKey, "lessons?on_conflict=id", lessons, 20, { upsert: true });

  log("Inserting resources...");
  await insertRows(serviceKey, "learning_resources", resources, 20);

  log("Inserting embedded chunks...");
  await insertRows(serviceKey, "resource_chunks", chunks, 30);

  const resourceCount = await rest(
    serviceKey,
    `learning_resources?course_id=eq.${COURSE_ID}&select=id`,
    { prefer: "count" },
  );
  const chunkCount = await rest(
    serviceKey,
    `resource_chunks?select=id&resource_id=in.(${resources.map((resource) => resource.id).join(",")})`,
    { prefer: "count" },
  );
  log(
    `Done. course=${COURSE_ID} lessons=${lessons.length} resources=${resourceCount.headers.get("content-range") ?? resources.length} chunks=${chunkCount.headers.get("content-range") ?? chunks.length}`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
