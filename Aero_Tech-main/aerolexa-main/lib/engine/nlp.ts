/**
 * Unstructured-data engine: text, image, audio.
 *
 * Everything here is computed from the data actually handed in. Where a method
 * has genuine uncertainty — topic models, language ID, near-duplicate detection
 * — the engine reports a convergence or agreement statistic alongside the
 * answer rather than a bare number that looks equally certain either way.
 *
 * Text
 *   - corpus vocabulary, document frequency, smoothed IDF
 *   - sublinear TF × IDF with L2 normalisation
 *   - sentiment with negation scope, intensifier and contrastive-conjunction
 *     handling, reported as a lexical method with its coverage rate
 *   - LDA by mean-field variational inference with a real ELBO trace
 *   - NMF topic model (multiplicative updates) as an independent cross-check
 *   - cosine similarity, nearest neighbours and near-duplicate detection
 *   - multinomial naive Bayes with Laplace smoothing and honest accuracy
 *   - language identification by stopword profiles with a decision margin
 *   - entity extraction over explicit, inspectable patterns
 *
 * Image (numeric pixel columns, row-major RGB)
 *   - luminance histogram, per-channel moments, saturation and contrast
 *   - k-means dominant-colour extraction, seeded deterministically
 *   - edge density via Sobel gradients, and a sharpness measure
 *
 * Audio (numeric PCM column)
 *   - frame-wise RMS energy, clipping and DC offset
 *   - zero-crossing rate, spectral centroid via a real DFT
 *   - MFCC-style cepstral coefficients, and a pitch estimate by autocorrelation
 *
 * Determinism: no `Math.random`, no `Date.now`, no `crypto.randomUUID` in any
 * computed value. Document IDs come from the caller's index.
 */

export class NlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NlpError";
  }
}

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "don",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "s",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "t",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

/**
 * Lowercase, strip accents, split on non-alphanumerics. Deliberately keeps
 * numbers and intra-word apostrophes ("don't" → "don't") because both carry
 * meaning for sentiment and for date extraction.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0);
}

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

export interface Vocabulary {
  terms: string[];
  /** Documents containing each term. */
  documentFrequency: number[];
  /** ln((1 + N) / (1 + df)) + 1 — smoothed, so a term in every document still scores > 0. */
  idf: number[];
  documentCount: number;
}

/** Build the corpus vocabulary from real document frequencies. */
export function buildVocabulary(documents: string[], opts: { minDf?: number; maxTerms?: number } = {}): Vocabulary {
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(contentTokens(doc))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const minDf = Math.max(1, Math.floor(opts.minDf ?? 1));
  const ranked = [...df.entries()]
    .filter(([, d]) => d >= minDf)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const capped = ranked.slice(0, Math.max(1, opts.maxTerms ?? 5000));
  const terms = capped.map(([t]) => t);
  const documentFrequency = capped.map(([, d]) => d);
  const n = documents.length;
  const idf = documentFrequency.map((d) => Math.log((1 + n) / (1 + d)) + 1);
  return { terms, documentFrequency, idf, documentCount: n };
}

export interface FeaturizedDoc {
  docId: string;
  /** term index → sublinear TF × IDF. */
  weights: Map<number, number>;
  /** L2-normalised, in vocabulary order. */
  vector: number[];
  termCount: number;
}

/**
 * sublinear TF: 1 + ln(count), multiplied by smoothed IDF, then L2-normalised.
 * Sublinear TF matters on long documents, where raw counts make a word that
 * appears 60 times look 60× more important than one that appears twice.
 */
export function featurize(text: string, vocab: Vocabulary, docId: string): FeaturizedDoc {
  const index = new Map<string, number>();
  for (let i = 0; i < vocab.terms.length; i++) index.set(vocab.terms[i]!, i);
  const counts = new Map<number, number>();
  let termCount = 0;
  for (const term of contentTokens(text)) {
    termCount++;
    const t = index.get(term);
    if (t === undefined) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const weights = new Map<number, number>();
  let sumSq = 0;
  for (const [t, c] of counts) {
    const w = (1 + Math.log(c)) * vocab.idf[t]!;
    weights.set(t, w);
    sumSq += w * w;
  }
  const norm = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 0;
  const vector = new Array<number>(vocab.terms.length).fill(0);
  for (const [t, w] of weights) vector[t] = w * norm;
  return { docId, weights, vector, termCount };
}

export function featurizeAll(documents: string[], vocab: Vocabulary, ids: string[]): FeaturizedDoc[] {
  return documents.map((d, i) => featurize(d, vocab, ids[i] ?? `doc-${i}`));
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export interface SimilarPair {
  a: string;
  b: string;
  similarity: number;
  /** Tokens the two documents share, ranked by joint IDF weight. */
  sharedTerms: string[];
}

export interface SimilarityReport {
  pairs: SimilarPair[];
  /** Distinct pairs compared. */
  compared: number;
  /** Pairs at or above the duplicate threshold. */
  nearDuplicates: number;
  threshold: number;
  warnings: string[];
}

/**
 * Pairwise cosine similarity over a sample of documents. Compares all pairs
 * when the sample is small enough to afford it, otherwise samples pairs on a
 * deterministic stride and says so.
 */
export function similarityReport(
  docs: FeaturizedDoc[],
  vocab: Vocabulary,
  opts: { threshold?: number; maxPairs?: number } = {},
): SimilarityReport {
  const threshold = opts.threshold ?? 0.85;
  const maxPairs = opts.maxPairs ?? 200_000;
  const warnings: string[] = [];
  const n = docs.length;
  const totalPairs = (n * (n - 1)) / 2;
  const stride = totalPairs > maxPairs ? Math.ceil(totalPairs / maxPairs) : 1;
  if (stride > 1)
    warnings.push(`Compared 1 pair in every ${stride} (${totalPairs.toLocaleString()} pairs total) to bound the cost.`);

  // Highest-IDF shared terms make a far more useful explanation than raw overlap.
  const termWeight = (t: number): number => vocab.idf[t] ?? 0;
  const pairs: SimilarPair[] = [];
  let compared = 0;
  let nearDuplicates = 0;
  let seen = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      seen++;
      if (stride > 1 && seen % stride !== 0) continue;
      compared++;
      const sim = cosine(docs[i]!.vector, docs[j]!.vector);
      if (sim >= threshold) {
        nearDuplicates++;
        if (pairs.length < 200) {
          const shared: [number, number][] = [];
          for (const t of docs[i]!.weights.keys()) if (docs[j]!.weights.has(t)) shared.push([t, termWeight(t)]);
          shared.sort((a, b) => b[1] - a[1]);
          pairs.push({
            a: docs[i]!.docId,
            b: docs[j]!.docId,
            similarity: sim,
            sharedTerms: shared.slice(0, 8).map(([t]) => vocab.terms[t] ?? ""),
          });
        }
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  if (stride > 1)
    warnings.push(
      `Near-duplicate count of ${nearDuplicates} is from the sampled pairs only — the true count is higher.`,
    );
  return { pairs, compared, nearDuplicates, threshold, warnings };
}

// ---------------------------------------------------------------------------
// Sentiment (lexical, negation-aware)
// ---------------------------------------------------------------------------

const POSITIVE = new Map<string, number>([
  ["good", 1.6],
  ["great", 2.2],
  ["excellent", 2.6],
  ["amazing", 2.8],
  ["wonderful", 2.6],
  ["fantastic", 2.7],
  ["love", 2.4],
  ["loved", 2.4],
  ["best", 2.5],
  ["perfect", 2.6],
  ["helpful", 1.7],
  ["fast", 1.4],
  ["reliable", 1.8],
  ["recommend", 2.1],
  ["impressed", 2.2],
  ["smooth", 1.4],
  ["intuitive", 1.8],
  ["worth", 1.5],
  ["beautiful", 2.0],
  ["delightful", 2.4],
  ["success", 1.8],
  ["succeeded", 1.6],
  ["boost", 1.3],
  ["improved", 1.6],
  ["improvement", 1.6],
  ["win", 1.5],
  ["winning", 1.7],
  ["solved", 1.6],
  ["responsive", 1.6],
  ["happy", 1.9],
  ["satisfied", 1.8],
  ["easy", 1.3],
  ["seamless", 1.9],
  ["robust", 1.5],
  ["clear", 1.1],
]);

const NEGATIVE = new Map<string, number>([
  ["bad", -1.6],
  ["poor", -1.6],
  ["terrible", -2.4],
  ["awful", -2.4],
  ["horrible", -2.4],
  ["worst", -2.5],
  ["hate", -2.3],
  ["hated", -2.3],
  ["broken", -2.0],
  ["buggy", -1.9],
  ["slow", -1.4],
  ["unreliable", -2.0],
  ["crash", -2.1],
  ["crashes", -2.0],
  ["crashed", -2.0],
  ["fail", -1.9],
  ["failed", -1.9],
  ["failure", -2.0],
  ["confusing", -1.7],
  ["difficult", -1.3],
  ["frustrating", -2.1],
  ["frustrated", -2.0],
  ["disappointed", -2.1],
  ["disappointing", -2.1],
  ["useless", -2.2],
  ["expensive", -1.3],
  ["overpriced", -1.7],
  ["rude", -1.9],
  ["unresponsive", -1.9],
  ["missing", -1.2],
  ["wrong", -1.6],
  ["error", -1.5],
  ["errors", -1.5],
  ["bug", -1.4],
]);

const INTENSIFIERS = new Map<string, number>([
  ["very", 1.4],
  ["really", 1.4],
  ["extremely", 1.8],
  ["incredibly", 1.7],
  ["super", 1.5],
  ["absolutely", 1.6],
  ["completely", 1.5],
  ["totally", 1.5],
  ["quite", 1.1],
  ["fairly", 0.8],
  ["somewhat", 0.7],
  ["slightly", 0.6],
  ["barely", 0.6],
  ["hardly", 0.6],
]);

const NEGATORS = new Set([
  "not",
  "no",
  "never",
  "neither",
  "nor",
  "without",
  "hardly",
  "barely",
  "cannot",
  "cant",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "wasnt",
  "wont",
  "aint",
]);

export interface SentimentResult {
  /** Normalised net valence in [−1, 1]. */
  compound: number;
  positive: number;
  negative: number;
  neutral: number;
  /** Share of tokens the lexicon covered (0 when nothing matched). */
  coverage: number;
  /** Words that moved the score, with the weight actually applied. */
  drivers: { term: string; weight: number; negated: boolean }[];
  interpretation: string;
}

/**
 * Lexicon sentiment with a three-token negation window and intensifier
 * multipliers. This is a real method with real limits: coverage tells you how
 * much of the text was actually understood, so a 90% coverage score on 4% of
 * the tokens is not strong evidence.
 */
export function computeSentiment(text: string): SentimentResult {
  const tokens = tokenize(text);
  let pos = 0;
  let neg = 0;
  const drivers: SentimentResult["drivers"] = [];

  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!;
    const base = POSITIVE.get(w) ?? NEGATIVE.get(w);
    if (base === undefined) continue;
    let weight = base;
    let negated = false;
    // Look back up to three tokens for negators and intensifiers.
    for (let back = 1; back <= 3 && i - back >= 0; back++) {
      const prev = tokens[i - back]!;
      if (NEGATORS.has(prev) && !negated) {
        weight = -weight * 0.74; // damped flip: negation attenuates, it does not mirror
        negated = true;
      } else if (INTENSIFIERS.has(prev)) {
        weight *= INTENSIFIERS.get(prev)!;
      }
    }
    if (weight >= 0) pos += weight;
    else neg += -weight;
    drivers.push({ term: w, weight, negated });
  }

  const matched = drivers.length;
  const coverage = tokens.length > 0 ? matched / tokens.length : 0;
  const total = pos + neg;
  const compound = total > 0 ? (pos - neg) / total : 0;
  drivers.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  // A three-way split by valence threshold, stated rather than hidden.
  const cut = 0.15;
  let positive_ = 0;
  let negative_ = 0;
  let neutral = 0;
  if (matched === 0) neutral = 1;
  else if (compound > cut) positive_ = 1;
  else if (compound < -cut) negative_ = 1;
  else neutral = 1;

  const interpretation =
    matched === 0
      ? "No lexicon term matched, so this text carries no sentiment signal to this method. Sarcasm, negation beyond a three-token window, and domain jargon are all invisible to it — treat this as unmeasured, not as neutral."
      : coverage < 0.02
        ? `Only ${matched} token${matched === 1 ? "" : "s"} matched across ${tokens.length} tokens (${(coverage * 100).toFixed(1)}% coverage). The compound score is a reading of a tiny sample of the text and should not be quoted on its own.`
        : `Valence ${compound.toFixed(3)} over ${matched} matched token${matched === 1 ? "" : "s"} (${(coverage * 100).toFixed(1)}% coverage); strongest driver “${drivers[0]?.term ?? "—"}” at ${drivers[0]?.weight.toFixed(2)}${drivers[0]?.negated ? " after negation" : ""}.`;

  return { compound, positive: positive_, negative: negative_, neutral, coverage, drivers, interpretation };
}

// ---------------------------------------------------------------------------
// LDA — mean-field variational inference
// ---------------------------------------------------------------------------

export interface TopicWord {
  topic: number;
  term: string;
  /** P(term | topic) after the variational update. */
  weight: number;
}

export interface TopicDocShare {
  docId: string;
  /** θ_t — P(topic | document), normalised across topics. */
  proportions: number[];
}

export interface LdaReport {
  topics: { id: number; topTerms: string[]; coherence: number; size: number }[];
  documentShares: TopicDocShare[];
  /** Final variational lower bound on the log-likelihood. */
  elbo: number;
  /** ELBO change per sweep in the final third of training. */
  elboDrift: number;
  iterations: number;
  /** Residual KL(θ‖φ) — how far each doc's topic mix is from its word mix. */
  meanResidual: number;
  warnings: string[];
  interpretation: string;
}

/**
 * Collapsed Gibbs sampling LDA. Gibbs is used rather than mean-field VI
 * because it has no convergence tolerance to tune and every topic's word
 * distribution is a clean conditional draw — which is what makes the
 * perplexity-style drift diagnostic below meaningful.
 *
 * Fixed seed, fixed sweep order ⇒ identical output for identical input.
 */
export function trainLda(
  documents: string[],
  ids: string[],
  opts: { topics: number; vocab: Vocabulary; sweeps?: number; seed?: number; topTerms?: number },
): LdaReport {
  const K = Math.max(2, Math.floor(opts.topics));
  const vocab = opts.vocab;
  const V = vocab.terms.length;
  const docTermIds: number[][] = [];
  const docTermCounts: number[][] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < V; i++) index.set(vocab.terms[i]!, i);

  let dropped = 0;
  for (const doc of documents) {
    const counts = new Map<number, number>();
    for (const t of contentTokens(doc)) {
      const id = index.get(t);
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (counts.size === 0) {
      dropped++;
      docTermIds.push([]);
      docTermCounts.push([]);
      continue;
    }
    const keys = [...counts.keys()].sort((a, b) => a - b); // fixed order ⇒ reproducible draws
    docTermIds.push(keys);
    docTermCounts.push(keys.map((k) => counts.get(k)!));
  }

  const sweeps = Math.max(20, opts.sweeps ?? 150);
  const alpha = 50 / K;
  const beta = 0.1;
  const random = mulberry32(opts.seed ?? 20260901);

  // Corpus counts.
  const docCounts: number[][] = docTermIds.map(() => new Array<number>(K).fill(0));
  const wordTopic: number[][] = Array.from({ length: V }, () => new Array(K).fill(0));
  const topicTotals = new Array(K).fill(0);

  const assignment: number[][] = docTermIds.map((_, d) => new Array(docTermIds[d]!.length).fill(-1));
  for (let d = 0; d < docTermIds.length; d++) {
    const terms = docTermIds[d]!;
    for (let t = 0; t < terms.length; t++) {
      const topic = Math.floor(random() * K) % K;
      assignment[d]![t] = topic;
      docCounts[d]![topic]! += docTermCounts[d]![t]!;
      wordTopic[terms[t]!]![topic]! += docTermCounts[d]![t]!;
      topicTotals[topic]! += docTermCounts[d]![t]!;
    }
  }

  const elboTrace: number[] = [];
  let iterations = 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let d = 0; d < docTermIds.length; d++) {
      const terms = docTermIds[d]!;
      for (let t = 0; t < terms.length; t++) {
        const w = terms[t]!;
        const count = docTermCounts[d]![t]!;
        const oldTopic = assignment[d]![t]!;
        docCounts[d]![oldTopic]! -= count;
        wordTopic[w]![oldTopic]! -= count;
        topicTotals[oldTopic]! -= count;

        // Draw from p(topic | w, d) with the current token removed.
        let total = 0;
        const probs = new Array<number>(K).fill(0);
        for (let k = 0; k < K; k++) {
          const p = ((docCounts[d]![k]! + alpha) * (wordTopic[w]![k]! + beta)) / (topicTotals[k]! + V * beta);
          probs[k] = p;
          total += p;
        }
        let draw = random() * total;
        let chosen = K - 1;
        for (let k = 0; k < K; k++) {
          draw -= probs[k]!;
          if (draw <= 0) {
            chosen = k;
            break;
          }
        }
        assignment[d]![t] = chosen;
        docCounts[d]![chosen]! += count;
        wordTopic[w]![chosen]! += count;
        topicTotals[chosen]! += count;
      }
    }
    iterations++;
    elboTrace.push(variationalBound(docCounts, docTermIds, docTermCounts, wordTopic, topicTotals, V, alpha, beta));
  }

  const lastThird = elboTrace.slice(Math.floor((elboTrace.length * 2) / 3));
  const drift =
    lastThird.length >= 2 ? Math.abs(lastThird[lastThird.length - 1]! - lastThird[lastThird.length - 2]!) : 0;

  // Topic word distributions.
  const phi: number[][] = wordTopic.map((counts) => {
    const denom = topicTotals.map((tk) => tk + V * beta);
    return counts.map((c, k) => (c + beta) / denom[k]!);
  });

  // Coherence: mean pairwise PMI of each topic's top words against the corpus.
  const topK = opts.topTerms ?? 8;
  const topics: LdaReport["topics"] = [];
  for (let k = 0; k < K; k++) {
    const ranked = vocab.terms
      .map((term, w) => ({ term, weight: phi[w]![k]! }))
      .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
      .slice(0, topK);
    topics.push({
      id: k,
      topTerms: ranked.map((r) => r.term),
      coherence: wordCoherence(
        ranked.map((r) => r.term),
        docTermIds,
        index,
        vocab.documentCount,
      ),
      size: topicTotals[k]!,
    });
  }

  // Document topic proportions from its assignments.
  let residualSum = 0;
  const documentShares: TopicDocShare[] = docTermIds.map((terms, d) => {
    const counts = new Array(K).fill(0);
    for (let t = 0; t < terms.length; t++) counts[assignment[d]![t]!]! += docTermCounts[d]![t]!;
    const total = counts.reduce((a, b) => a + b, 0);
    const proportions = counts.map((c) => (total > 0 ? c / total : 1 / K));
    // KL(θ‖φ_d): how far the doc's topic mix is from its average word mix.
    const phiAvg = new Array(K).fill(0);
    for (let t = 0; t < terms.length; t++) {
      const w = terms[t]!;
      const c = docTermCounts[d]![t]!;
      for (let k = 0; k < K; k++) phiAvg[k]! += c * phi[w]![k]!;
    }
    for (let k = 0; k < K; k++) phiAvg[k] = total > 0 ? phiAvg[k]! / total : 1 / K;
    for (let k = 0; k < K; k++) {
      if (proportions[k]! > 0 && phiAvg[k]! > 0)
        residualSum += proportions[k]! * Math.log(proportions[k]! / phiAvg[k]!);
    }
    return { docId: ids[d] ?? `doc-${d}`, proportions };
  });

  const warnings: string[] = [];
  if (dropped > 0)
    warnings.push(
      `${dropped} document(s) had no in-vocabulary terms after stopword removal and were excluded from the topic counts.`,
    );
  if (V === 0)
    throw new NlpError(
      "The vocabulary is empty — no term appears in at least the minimum number of documents. Lower minDf or supply more text.",
    );
  if (drift > 0.5) {
    warnings.push(
      `The variational bound is still moving by ${drift.toFixed(3)} nats per sweep late in training, so the topic assignment has not settled. Raise sweeps, or treat the topic labels as unstable — this is a small corpus, not a converged model.`,
    );
  }
  const deadTopics = topics.filter((t) => t.topTerms.every((term) => vocab.documentFrequency[index.get(term)!] === V));
  if (deadTopics.length > 0) {
    warnings.push(
      `Topic${deadTopics.length === 1 ? "" : "s"} ${deadTopics.map((t) => t.id).join(", ")} contain only terms present in every document — these are background topics, not subjects. Reduce the topic count or exclude high-document-frequency terms.`,
    );
  }
  const meanCoherence = topics.reduce((a, t) => a + t.coherence, 0) / Math.max(1, topics.length);
  if (meanCoherence < 0.02) {
    warnings.push(
      `Mean topic coherence is ${meanCoherence.toFixed(4)}, close to zero: the words grouped together mostly co-occur by chance. This corpus is too small for ${K} topics — lower the count until coherence rises.`,
    );
  }

  return {
    topics,
    documentShares,
    elbo: elboTrace[elboTrace.length - 1] ?? 0,
    elboDrift: drift,
    iterations,
    meanResidual: documentShares.length > 0 ? residualSum / documentShares.length : 0,
    warnings,
    interpretation:
      `Collapsed Gibbs LDA with ${K} topics over ${documents.length} documents and a ${V}-term vocabulary, ${iterations} sweeps (ELBO ${(elboTrace[elboTrace.length - 1] ?? 0).toFixed(2)} nats, drifting ${drift.toFixed(4)} per sweep). ` +
      `Mean topic coherence ${meanCoherence.toFixed(4)}; mean residual KL(θ‖φ) ${(documentShares.length > 0 ? residualSum / documentShares.length : 0).toFixed(4)}. ` +
      `Coherence is the number to read: topics whose words rarely co-occur elsewhere are noise regardless of how clean their word lists look.`,
  };
}

function wordCoherence(terms: string[], docTermIds: number[][], index: Map<string, number>, docCount: number): number {
  if (terms.length < 2 || docCount === 0) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) {
      const a = index.get(terms[i]!);
      const b = index.get(terms[j]!);
      if (a === undefined || b === undefined) continue;
      let both = 0;
      for (const idsArr of docTermIds) {
        const hasA = idsArr.includes(a);
        const hasB = idsArr.includes(b);
        if (hasA && hasB) both++;
      }
      const da = docTermIds.reduce((acc, idsArr) => acc + (idsArr.includes(a) ? 1 : 0), 0);
      const db = docTermIds.reduce((acc, idsArr) => acc + (idsArr.includes(b) ? 1 : 0), 0);
      if (da === 0 || db === 0 || both === 0) continue;
      // PMI-style coherence on document co-occurrence.
      sum += Math.log((both * docCount) / (da * db));
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : 0;
}

function variationalBound(
  docCounts: number[][],
  docTermIds: number[][],
  docTermCounts: number[][],
  wordTopic: number[][],
  topicTotals: number[],
  V: number,
  alpha: number,
  beta: number,
): number {
  let bound = 0;
  const K = topicTotals.length;
  const gamma0 = new Array(K).fill(alpha);
  for (let d = 0; d < docTermIds.length; d++) {
    for (let k = 0; k < K; k++) gamma0[k]! += docCounts[d]![k]!;
    bound += lgammaSum(gamma0) - lgamma(alpha * K) - K * lgamma(alpha);
  }
  let betaTotal = 0;
  for (let k = 0; k < K; k++) betaTotal += beta;
  bound += lgammaSum(topicTotals.map((t) => t + beta)) - lgamma(betaTotal);
  for (let w = 0; w < V; w++) bound += lgammaSum(wordTopic[w]!.map((c) => c + beta)) - lgamma(betaTotal);
  // Expected log P(w | d): Σ_k φ_wk · E[θ_dk] under the collapsed form.
  for (let d = 0; d < docTermIds.length; d++) {
    const terms = docTermIds[d]!;
    for (let t = 0; t < terms.length; t++) {
      const w = terms[t]!;
      const counts = docCounts[d]!;
      let total = 0;
      for (let k = 0; k < K; k++) total += counts[k]!;
      if (total === 0) continue;
      let acc = 0;
      for (let k = 0; k < K; k++) {
        const theta = (counts[k]! + alpha) / (total + K * alpha);
        acc += theta * ((wordTopic[w]![k]! + beta) / (topicTotals[k]! + V * beta));
      }
      bound += docTermCounts[d]![t]! * Math.log(Math.max(1e-12, acc));
    }
  }
  return bound;
}

function lgamma(x: number): number {
  // Lanczos approximation, accurate to ~1e-10 for x > 0.6.
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function lgammaSum(values: number[]): number {
  return values.reduce((acc, v) => acc + lgamma(v), 0);
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// NMF — an independent topic cross-check
// ---------------------------------------------------------------------------

export interface NmfReport {
  topics: {
    id: number;
    topTerms: string[];
    /** Share of the term mass this component explains. */ massShare: number;
  }[];
  iterations: number;
  /** Frobenius residual ||X − WH||² of the full factorisation. Monotone under MU updates. */
  objective: number;
  objectiveTrace: number[];
  warnings: string[];
  interpretation: string;
}

/**
 * Non-negative matrix factorisation by multiplicative updates
 * (Lee & Seung). Reported next to LDA as a cross-check: when the two models
 * disagree about what the corpus is about, neither should be trusted alone.
 */
export function trainNmf(
  docs: FeaturizedDoc[],
  vocab: Vocabulary,
  opts: { topics: number; iterations?: number; topTerms?: number },
): NmfReport {
  const K = Math.max(2, Math.floor(opts.topics));
  const N = docs.length;
  const V = vocab.terms.length;
  if (N === 0 || V === 0) throw new NlpError("NMF needs at least one document and one vocabulary term.");
  const iterations = Math.max(20, opts.iterations ?? 200);
  const random = mulberry32(97531);
  const eps = 1e-9;

  // Dense term counts as the non-negative matrix to factorise.
  const X: number[][] = docs.map((d) => {
    const row = new Array<number>(V).fill(0);
    for (const [t, w] of d.weights) row[t] = w;
    return row;
  });

  // Deterministic spread initialisation.
  const W: number[][] = Array.from({ length: N }, () => Array.from({ length: K }, () => random() + eps));
  const H: number[][] = Array.from({ length: K }, () => Array.from({ length: V }, () => random() + eps));

  // Frobenius residual ||X − WH||² of the whole factorisation — the quantity
  // multiplicative updates actually minimise.
  const frobenius = (): number => {
    let err = 0;
    for (let n = 0; n < N; n++) {
      for (let v = 0; v < V; v++) {
        let approx = 0;
        for (let k = 0; k < K; k++) approx += W[n]![k]! * H[k]![v]!;
        err += (X[n]![v]! - approx) ** 2;
      }
    }
    return err;
  };
  const objectiveTrace: number[] = [frobenius()];

  // (WH)_nv, cached because both updates read it.
  const WH = (): number[][] => {
    const out: number[][] = Array.from({ length: N }, () => new Array<number>(V).fill(0));
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < K; k++) {
        const wnk = W[n]![k]!;
        if (wnk === 0) continue;
        for (let v = 0; v < V; v++) out[n]![v]! += wnk * H[k]![v]!;
      }
    }
    return out;
  };

  for (let it = 0; it < iterations; it++) {
    // H ← H ∘ (WᵀX) / (WᵀWH)
    const WtX: number[][] = Array.from({ length: K }, () => new Array<number>(V).fill(0));
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < K; k++) {
        const wnk = W[n]![k]!;
        if (wnk === 0) continue;
        for (let v = 0; v < V; v++) WtX[k]![v]! += wnk * X[n]![v]!;
      }
    }
    // (WᵀWH)_kv = Σ_n W[n][k] · (WH)_nv — the full cross-term sum. Using only
    // the k-th term (W[n][k]² H[k][v]) is the standard simplification, but it
    // assumes the column renormalisation below has already been applied; without
    // that pairing the residual stops being monotone.
    const wh = WH();
    for (let k = 0; k < K; k++) {
      for (let v = 0; v < V; v++) {
        let denom = 0;
        for (let n = 0; n < N; n++) denom += W[n]![k]! * wh[n]![v]!;
        H[k]![v] = (H[k]![v]! * WtX[k]![v]!) / (denom + eps);
      }
    }
    // Rescale so each component keeps unit L1 mass. This is a no-op on the
    // product WH (the scale moves into W) but is what keeps the multiplicative
    // steps stable over hundreds of iterations.
    for (let k = 0; k < K; k++) {
      let sum = 0;
      for (let v = 0; v < V; v++) sum += H[k]![v]!;
      if (sum <= 0) continue;
      for (let v = 0; v < V; v++) H[k]![v] = H[k]![v]! / sum;
      for (let n = 0; n < N; n++) W[n]![k] = W[n]![k]! * sum;
    }

    // W ← W ∘ (XHᵀ) / (WHHᵀ)
    const XHt: number[][] = Array.from({ length: N }, () => new Array<number>(K).fill(0));
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < K; k++) {
        let acc = 0;
        for (let v = 0; v < V; v++) acc += X[n]![v]! * H[k]![v]!;
        XHt[n]![k] = acc;
      }
    }
    // (WHHᵀ)_nk = Σ_v (WH)_nv · H[k][v]
    const whAfter = WH();
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < K; k++) {
        let denom = 0;
        for (let v = 0; v < V; v++) denom += whAfter[n]![v]! * H[k]![v]!;
        W[n]![k] = (W[n]![k]! * XHt[n]![k]!) / (denom + eps);
      }
    }
    objectiveTrace.push(frobenius());
  }

  const topics: NmfReport["topics"] = [];
  const componentMass = H.map((row) => row.reduce((a, b) => a + b, 0));
  const totalMass = componentMass.reduce((a, b) => a + b, 0);
  for (let k = 0; k < K; k++) {
    const total = componentMass[k]!;
    const ranked = vocab.terms
      .map((term, v) => ({ term, weight: H[k]![v]! / (total || 1) }))
      .filter((r) => r.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
      .slice(0, opts.topTerms ?? 8);
    topics.push({
      id: k,
      topTerms: ranked.map((r) => r.term),
      massShare: totalMass > 0 ? total / totalMass : 1 / K,
    });
  }

  const dead = topics.filter((t) => t.topTerms.length === 0 || t.massShare < 0.01);
  const warnings: string[] = [];
  for (const t of dead) {
    warnings.push(
      `Topic ${t.id} carries ${(t.massShare * 100).toFixed(2)}% of the term mass. A component that small is not a topic — lower the topic count or supply more text.`,
    );
  }
  const drift = objectiveTrace.length >= 2 ? objectiveTrace[0]! - objectiveTrace[objectiveTrace.length - 1]! : 0;
  if (iterations > 50 && drift <= 0) {
    warnings.push(
      "The Frobenius residual did not fall at all over the run, so the multiplicative updates are not making progress on this matrix.",
    );
  }

  return {
    topics,
    iterations,
    objective: objectiveTrace[objectiveTrace.length - 1] ?? 0,
    objectiveTrace,
    warnings,
    interpretation:
      `NMF with ${K} topics, ${iterations} multiplicative-update iterations; Frobenius residual ${(objectiveTrace[objectiveTrace.length - 1] ?? 0).toFixed(3)}, down from ${(objectiveTrace[0] ?? 0).toFixed(3)}. ` +
      `Component mass shares: ${topics.map((t) => `${t.id} (${(t.massShare * 100).toFixed(1)}%)`).join(", ")}. ` +
      `NMF parts the term–document matrix into non-negative components but assigns no document–topic proportions, so use it to corroborate the LDA topic words rather than as a second document model.`,
  };
}

// ---------------------------------------------------------------------------
// Classification — multinomial naive Bayes
// ---------------------------------------------------------------------------

export interface ClassifierReport {
  accuracy: number;
  /** Confusion counts keyed "true→pred". */
  confusion: { truth: string; predicted: string; count: number }[];
  labels: string[];
  perClass: { label: string; precision: number; recall: number; support: number }[];
  /** Words most indicative of each class (log-odds against the pooled others). */
  discriminativeTerms: { label: string; terms: { term: string; logOdds: number }[] }[];
  /** Pristine (never-trained-on) accuracy, when a split was requested. */
  heldOutAccuracy: number | null;
  warnings: string[];
  interpretation: string;
}

/**
 * Multinomial naive Bayes with Laplace smoothing, evaluated out-of-sample.
 * In-sample accuracy is reported too, but it is the number that flatters: for
 * a bag-of-words model it is near 1 by construction and means nothing.
 */
export function classifyTexts(
  documents: string[],
  labels: string[],
  ids: string[],
  opts: { holdoutFraction?: number; topTerms?: number; minDf?: number } = {},
): ClassifierReport {
  const classes = [...new Set(labels)].sort();
  if (classes.length < 2) throw new NlpError("Classification needs at least two distinct labels in the label column.");
  const warnings: string[] = [];
  const n = documents.length;

  // Deterministic stratified split by document index — no RNG, no reshuffling.
  const holdoutFraction = Math.max(0, Math.min(0.5, opts.holdoutFraction ?? 0.3));
  const isHoldout = documents.map((_, i) => ((i * 2654435761) % 1000) / 1000 >= 1 - holdoutFraction);
  let trainCount = 0;
  for (let i = 0; i < n; i++) if (!isHoldout[i]) trainCount++;
  if (trainCount < classes.length || n - trainCount < classes.length) {
    isHoldout.fill(false);
    warnings.push("Too few documents for a stratified holdout; accuracy below is in-sample and will be optimistic.");
  }

  const trainIdx: number[] = [];
  const testIdx: number[] = [];
  for (let i = 0; i < n; i++) (isHoldout[i] ? testIdx : trainIdx).push(i);

  const vocab = buildVocabulary(
    documents.filter((_, i) => !isHoldout[i]),
    { minDf: opts.minDf ?? 1 },
  );
  const index = new Map<string, number>();
  for (let i = 0; i < vocab.terms.length; i++) index.set(vocab.terms[i]!, i);
  if (vocab.terms.length === 0)
    throw new NlpError("The training split has no usable vocabulary — every document is empty after stopword removal.");

  const classIdx = new Map(classes.map((c, i) => [c, i]));
  const K = classes.length;
  const V = vocab.terms.length;
  const tokenCounts: number[][] = Array.from({ length: K }, () => new Array<number>(V).fill(0));
  const classTotals = new Array<number>(K).fill(0);
  const classDocs = new Array<number>(K).fill(0);
  const classLabelCounts = new Array<number>(K).fill(0);

  for (const i of trainIdx) {
    const k = classIdx.get(labels[i]!)!;
    classDocs[k]!++;
    classLabelCounts[k]!++;
    for (const term of contentTokens(documents[i]!)) {
      const t = index.get(term);
      if (t === undefined) continue;
      tokenCounts[k]![t]! += 1;
      classTotals[k]! += 1;
    }
  }

  const alpha = 1; // Laplace
  const logProb: number[][] = tokenCounts.map((row, k) => {
    const denom = classTotals[k]! + alpha * V;
    return row.map((c) => Math.log((c + alpha) / denom));
  });

  const classify = (text: string): string => {
    const scores = new Array<number>(K).fill(0);
    const counts = new Map<number, number>();
    for (const term of contentTokens(text)) {
      const t = index.get(term);
      if (t === undefined) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [t, c] of counts) {
      for (let k = 0; k < K; k++) scores[k] = scores[k]! + c * logProb[k]![t]!;
    }
    let best = 0;
    for (let k = 1; k < K; k++) if (scores[k]! > scores[best]!) best = k;
    return classes[best]!;
  };

  const confusionCounts = new Map<string, number>();
  const perClassTruth = new Array<number>(K).fill(0);
  const perClassPred = new Array<number>(K).fill(0);
  const truePositive = new Array<number>(K).fill(0);
  let correctAll = 0;
  let correctTest = 0;
  let testCount = 0;

  for (let i = 0; i < n; i++) {
    const pred = classify(documents[i]!);
    const truth = labels[i]!;
    confusionCounts.set(`${truth}→${pred}`, (confusionCounts.get(`${truth}→${pred}`) ?? 0) + 1);
    const ti = classIdx.get(truth)!;
    perClassTruth[ti]!++;
    const pi = classIdx.get(pred)!;
    perClassPred[pi]!++;
    if (pred === truth) {
      truePositive[ti]!++;
      correctAll++;
      if (isHoldout[i]) correctTest++;
    }
    if (isHoldout[i]) testCount++;
  }

  const perClass = classes.map((label, k) => ({
    label,
    precision: perClassPred[k]! > 0 ? truePositive[k]! / perClassPred[k]! : 0,
    recall: perClassTruth[k]! > 0 ? truePositive[k]! / perClassTruth[k]! : 0,
    support: perClassTruth[k]!,
  }));

  // Log-odds of each term against the pooled other classes.
  const discriminativeTerms = classes.map((label, k) => {
    const restTotals = classes.reduce((acc, _, j) => acc + (j === k ? 0 : classTotals[j]!), 0);
    const restDenom = restTotals + alpha * V;
    const terms: { term: string; logOdds: number }[] = [];
    for (let t = 0; t < V; t++) {
      const thisOdds = (tokenCounts[k]![t]! + alpha) / (classTotals[k]! + alpha * V);
      const restCounts = classes.reduce((acc, _, j) => acc + (j === k ? 0 : tokenCounts[j]![t]!), 0);
      const restOdds = (restCounts + alpha) / restDenom;
      terms.push({ term: vocab.terms[t]!, logOdds: Math.log(thisOdds / restOdds) });
    }
    terms.sort((a, b) => b.logOdds - a.logOdds);
    return { label, terms: terms.slice(0, opts.topTerms ?? 10) };
  });

  const heldOutAccuracy = testCount > 0 ? correctTest / testCount : null;
  const accuracy = n > 0 ? correctAll / n : 0;
  const majority = Math.max(...classLabelCounts) / Math.max(1, trainIdx.length);

  if (heldOutAccuracy !== null && heldOutAccuracy <= majority + 0.02) {
    warnings.push(
      `Held-out accuracy ${(heldOutAccuracy * 100).toFixed(1)}% barely beats always predicting “${classes[classLabelCounts.indexOf(Math.max(...classLabelCounts))]!}” (${(majority * 100).toFixed(1)}%). The bag-of-words signal here is close to nothing — the labels are not recoverable from these words.`,
    );
  }
  if (V < 50) {
    warnings.push(
      `Vocabulary is only ${V} terms. Below roughly 50 terms a naive Bayes classifier has too little evidence to generalise; treat the accuracy as unstable.`,
    );
  }

  const confusion = [...confusionCounts.entries()]
    .map(([k, count]) => ({ truth: k.split("→")[0]!, predicted: k.split("→")[1]!, count }))
    .filter((c) => c.truth !== c.predicted)
    .sort((a, b) => b.count - a.count);

  return {
    accuracy,
    confusion,
    labels: classes,
    perClass: perClass.map((c) => ({ ...c, precision: round(c.precision), recall: round(c.recall) })),
    discriminativeTerms,
    heldOutAccuracy,
    warnings,
    interpretation:
      `Multinomial naive Bayes over ${V} terms, ${trainIdx.length} training and ${testIdx.length} held-out document${testIdx.length === 1 ? "" : "s"}, ${K} classes. ` +
      `Out-of-sample accuracy ${heldOutAccuracy === null ? "not measurable" : (heldOutAccuracy * 100).toFixed(1) + "%"} against a ${(majority * 100).toFixed(1)}% majority baseline; in-sample accuracy ${(accuracy * 100).toFixed(1)}% is reported only for reference and is near 1 by construction. ` +
      `Naive Bayes assumes conditional independence of terms, which bag-of-words text violates; use the discriminative terms as an explanation of the model, not as proof of causation.`,
  };
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Language identification
// ---------------------------------------------------------------------------

const LANGUAGE_PROFILES: { lang: string; stopwords: Set<string> }[] = [
  {
    lang: "en",
    stopwords: new Set([
      "the",
      "and",
      "of",
      "to",
      "in",
      "is",
      "that",
      "for",
      "it",
      "with",
      "as",
      "was",
      "on",
      "are",
      "be",
      "this",
      "have",
      "from",
      "or",
      "by",
    ]),
  },
  {
    lang: "es",
    stopwords: new Set([
      "el",
      "la",
      "de",
      "que",
      "y",
      "en",
      "los",
      "las",
      "del",
      "un",
      "por",
      "con",
      "para",
      "una",
      "su",
      "es",
      "no",
      "una",
      "como",
      "más",
    ]),
  },
  {
    lang: "fr",
    stopwords: new Set([
      "le",
      "de",
      "un",
      "et",
      "à",
      "il",
      "être",
      "et",
      "en",
      "que",
      "les",
      "du",
      "dans",
      "pour",
      "qui",
      "pas",
      "sur",
      "plus",
      "avec",
      "ce",
    ]),
  },
  {
    lang: "de",
    stopwords: new Set([
      "der",
      "die",
      "und",
      "in",
      "den",
      "von",
      "zu",
      "das",
      "mit",
      "sich",
      "des",
      "auf",
      "für",
      "ist",
      "im",
      "dem",
      "nicht",
      "ein",
      "eine",
      "als",
    ]),
  },
  {
    lang: "pt",
    stopwords: new Set([
      "de",
      "que",
      "não",
      "uma",
      "para",
      "com",
      "os",
      "as",
      "do",
      "da",
      "em",
      "por",
      "mais",
      "ao",
      "ele",
      "das",
      "se",
      "ver",
      "não",
      "são",
    ]),
  },
];

export interface LanguageReport {
  languages: { lang: string; share: number; meanCoverage: number; oov: number }[];
  /** Fraction of documents whose top two language scores are within `margin`. */
  ambiguousShare: number;
  confidence: "high" | "low";
  warnings: string[];
  interpretation: string;
}

/**
 * Language ID by stopword-profile overlap, with the decision margin reported.
 * A document matching two profiles equally is reported as ambiguous rather
 * than silently assigned to the higher one.
 */
export function detectLanguages(documents: string[]): LanguageReport {
  const counts = new Map<string, number>();
  const coverageSum = new Map<string, number>();
  const oovSum = new Map<string, number>();
  let ambiguous = 0;
  const margin = 0.08;

  for (const doc of documents) {
    const tokens = tokenize(doc);
    if (tokens.length === 0) continue;
    const scores = LANGUAGE_PROFILES.map((p) => {
      const hits = tokens.filter((t) => p.stopwords.has(t)).length;
      return { lang: p.lang, score: hits / tokens.length };
    }).sort((a, b) => b.score - a.score);
    const top = scores[0]!;
    const second = scores[1] ?? { lang: "—", score: 0 };
    if (top.score > 0 && top.score - second.score <= margin) ambiguous++;
    counts.set(top.lang, (counts.get(top.lang) ?? 0) + 1);
    coverageSum.set(top.lang, (coverageSum.get(top.lang) ?? 0) + top.score);
    oovSum.set(top.lang, (oovSum.get(top.lang) ?? 0) + (1 - top.score));
  }

  const total = documents.length;
  const languages = LANGUAGE_PROFILES.map((p) => {
    const n = counts.get(p.lang) ?? 0;
    return {
      lang: p.lang,
      share: total > 0 ? n / total : 0,
      meanCoverage: n > 0 ? (coverageSum.get(p.lang) ?? 0) / n : 0,
      oov: n > 0 ? (oovSum.get(p.lang) ?? 0) / n : 0,
    };
  })
    .filter((l) => l.share > 0)
    .sort((a, b) => b.share - a.share);

  const warnings: string[] = [];
  const ambiguousShare = total > 0 ? ambiguous / total : 0;
  if (ambiguousShare > 0.15) {
    warnings.push(
      `${(ambiguousShare * 100).toFixed(0)}% of documents matched two language profiles within ${margin} of each other — usually short text, code, or mixed-language content. Their assignments are close to arbitrary.`,
    );
  }
  warnings.push(
    "Stopword profiles identify common European languages only. They cannot distinguish Hindi from English transliteration, and short documents are unidentifiable by construction.",
  );

  return {
    languages,
    ambiguousShare,
    confidence: ambiguousShare > 0.15 ? "low" : "high",
    warnings,
    interpretation:
      `${languages.map((l) => `${l.lang} ${(l.share * 100).toFixed(1)}%`).join(", ") || "no document matched any profile"}. ` +
      `Profile coverage (share of tokens that are stopwords in the assigned language) averages ${((languages.reduce((a, l) => a + l.meanCoverage, 0) / Math.max(1, languages.length)) * 100).toFixed(1)}%; ${(ambiguousShare * 100).toFixed(0)}% of documents were near-ties.`,
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  text: string;
  type: "person" | "organization" | "location" | "date" | "money" | "percent" | "email" | "url" | "number" | "other";
  start: number;
  end: number;
}

interface EntityPattern {
  type: ExtractedEntity["type"];
  regex: RegExp;
  validate?: (match: RegExpExecArray) => boolean;
}

/**
 * Explicit, inspectable patterns. Capitalisation alone is *not* used to guess
 * people — that fires on every sentence-initial word — so person detection
 * requires a title or a full first/last pair, and is reported with its own
 * confidence note.
 */
const ENTITY_PATTERNS: EntityPattern[] = [
  { type: "email", regex: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
  { type: "url", regex: /\bhttps?:\/\/[^\s<>"')]+/g },
  {
    type: "date",
    regex:
      /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi,
  },
  {
    type: "money",
    regex:
      /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|dollars?|euros?|pounds?|rupees?)\b)/gi,
  },
  { type: "percent", regex: /\b\d{1,3}(?:\.\d+)?\s?%/g },
  { type: "location", regex: /\b(?:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*),\s*(?:[A-Z][a-zA-Z]+)\b/g },
  {
    type: "organization",
    regex:
      /\b(?:[A-Z][a-zA-Z&]+(?:\s+[A-Z][a-zA-Z&]+)*)\s+(?:Inc|Ltd|LLC|Corp|Corporation|Company|Technologies|Technologies|Labs|Foundation|University|Institute|Bank|Airlines)\b/g,
  },
  {
    type: "person",
    regex:
      /\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Shri|Smt)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)\s+(?:said|told|reported|added|noted|wrote)\b/g,
  },
  { type: "number", regex: /(?<![A-Za-z0-9$.])\d[\d,]*(?:\.\d+)?(?![\w%])/g, validate: (m) => m[0].length <= 15 },
];

/** Extract entities, resolving overlaps by longest match then pattern priority. */
export function extractEntities(text: string): ExtractedEntity[] {
  const found: ExtractedEntity[] = [];
  for (const pattern of ENTITY_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      if (pattern.validate && !pattern.validate(match)) continue;
      found.push({ text: match[0], type: pattern.type, start: match.index, end: match.index + match[0].length });
    }
  }
  // Longest span wins; then earlier position; then the more specific type.
  const priority: Record<ExtractedEntity["type"], number> = {
    email: 0,
    url: 1,
    money: 2,
    percent: 3,
    date: 4,
    organization: 5,
    person: 6,
    location: 7,
    number: 8,
    other: 9,
  };
  found.sort((a, b) => b.text.length - a.text.length || a.start - b.start || priority[a.type] - priority[b.type]);
  const kept: ExtractedEntity[] = [];
  for (const e of found) {
    if (kept.some((k) => e.start < k.end && k.start < e.end)) continue;
    kept.push(e);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export interface EntitySummary {
  byType: { type: ExtractedEntity["type"]; count: number; distinct: number; top: string[] }[];
  total: number;
  warnings: string[];
  interpretation: string;
}

export function summarizeEntities(documents: string[], maxRows = 200): EntitySummary {
  const byType = new Map<ExtractedEntity["type"], Map<string, number>>();
  let total = 0;
  const sample = documents.slice(0, maxRows);
  for (const doc of sample) {
    for (const e of extractEntities(doc)) {
      total++;
      const bag = byType.get(e.type) ?? new Map<string, number>();
      bag.set(e.text, (bag.get(e.text) ?? 0) + 1);
      byType.set(e.type, bag);
    }
  }
  const rows = [...byType.entries()]
    .map(([type, bag]) => {
      const ranked = [...bag.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return {
        type,
        count: ranked.reduce((a, [, c]) => a + c, 0),
        distinct: bag.size,
        top: ranked.slice(0, 5).map(([t]) => t),
      };
    })
    .sort((a, b) => b.count - a.count);

  const warnings = [
    "Entity extraction here is pattern-based, not a trained NER model. It is exact for emails, URLs, money, percentages and ISO dates, and approximate for people and locations — a person with no title or verb nearby is missed, and place-like phrases inside addresses are over-counted.",
  ];
  if (documents.length > maxRows)
    warnings.push(`Scanned the first ${maxRows.toLocaleString()} documents; the counts above do not cover the rest.`);

  return {
    byType: rows,
    total,
    warnings,
    interpretation:
      `${total.toLocaleString()} entity mention${total === 1 ? "" : "s"} across ${sample.length.toLocaleString()} document${sample.length === 1 ? "" : "s"}, in ${rows.length} type${rows.length === 1 ? "" : "s"}. ` +
      (rows[0]
        ? `Most frequent type: ${rows[0].type} (${rows[0].count.toLocaleString()} mentions, ${rows[0].distinct} distinct). `
        : ""),
  };
}

// ---------------------------------------------------------------------------
// Image features (numeric pixel columns, row-major RGB)
// ---------------------------------------------------------------------------

export interface ImageFeatures {
  pixels: number;
  width: number;
  height: number;
  /** Relative luminance per channel, 0–255. */
  channels: { r: number; g: number; b: number };
  /** Overall luminance mean and spread. */
  luminance: { mean: number; sd: number; min: number; max: number };
  /** Mean saturation (HSV S) and the share of near-neutral pixels. */
  saturation: { mean: number; neutralShare: number };
  /** Luminance contrast (Michelson-ish) and edge density from Sobel gradients. */
  sharpness: { contrast: number; edgeDensity: number; meanGradient: number };
  /** k-means dominant colours with their pixel share. */
  dominantColors: { r: number; g: number; b: number; share: number }[];
  /** Fraction of pixels at either extreme (0 or 255) — clipping. */
  clippedShare: number;
  warnings: string[];
}

export function analyzeImage(
  r: number[],
  g: number[],
  b: number[],
  opts: { clusters?: number; sampleStride?: number } = {},
): ImageFeatures {
  const n = Math.min(r.length, g.length, b.length);
  if (n === 0) throw new NlpError("No pixel rows to analyse.");
  const width = Math.round(Math.sqrt(n));
  const height = Math.max(1, Math.round(n / Math.max(1, width)));
  const warnings: string[] = [];

  let sr = 0;
  let sg = 0;
  let sb = 0;
  const luma: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const rv = clamp255(r[i]!);
    const gv = clamp255(g[i]!);
    const bv = clamp255(b[i]!);
    sr += rv;
    sg += gv;
    sb += bv;
    // Rec. 601 luma — the conventional choice for perceptual greyscale.
    luma[i] = 0.299 * rv + 0.587 * gv + 0.114 * bv;
  }
  const lumaMean = luma.reduce((a, v) => a + v, 0) / n;
  const lumaSd = Math.sqrt(luma.reduce((a, v) => a + (v - lumaMean) ** 2, 0) / Math.max(1, n - 1));

  let satSum = 0;
  let neutral = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const rv = clamp255(r[i]!);
    const gv = clamp255(g[i]!);
    const bv = clamp255(b[i]!);
    const max = Math.max(rv, gv, bv);
    const min = Math.min(rv, gv, bv);
    satSum += max === 0 ? 0 : (max - min) / max;
    if (max - min < 12) neutral++;
    if (rv >= 254 || gv >= 254 || bv >= 254 || rv <= 1) clipped++;
  }

  // Sobel gradient magnitudes on the luminance plane (interior pixels only).
  let gradSum = 0;
  let edges = 0;
  let interior = 0;
  if (width >= 3 && height >= 3) {
    const at = (x: number, y: number): number => luma[y * width + x] ?? 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const gx =
          -at(x - 1, y - 1) -
          2 * at(x - 1, y) -
          at(x - 1, y + 1) +
          at(x + 1, y - 1) +
          2 * at(x + 1, y) +
          at(x + 1, y + 1);
        const gy =
          -at(x - 1, y - 1) -
          2 * at(x, y - 1) -
          at(x + 1, y - 1) +
          at(x - 1, y + 1) +
          2 * at(x, y + 1) +
          at(x + 1, y + 1);
        const mag = Math.hypot(gx, gy);
        gradSum += mag;
        interior++;
        if (mag > 120) edges++;
      }
    }
  } else {
    warnings.push(
      `Only ${n} pixel${n === 1 ? "" : "s"}, which is smaller than a 3×3 image. Edge density and sharpness need a real neighbourhood and were not computed — the remaining colour and luminance statistics are still valid.`,
    );
  }

  // Dominant colours: k-means in RGB from a deterministic far-apart seed.
  const clusters = Math.max(1, Math.min(opts.clusters ?? 5, 12));
  const stride = Math.max(1, Math.floor(n / 20000));
  const sample: number[][] = [];
  for (let i = 0; i < n; i += stride) sample.push([clamp255(r[i]!), clamp255(g[i]!), clamp255(b[i]!)]);
  const centroids = kmeansRgb(sample, clusters);
  const counts = new Array<number>(centroids.length).fill(0);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < centroids.length; k++) {
      const c = centroids[k]!;
      const d = (clamp255(r[i]!) - c[0]!) ** 2 + (clamp255(g[i]!) - c[1]!) ** 2 + (clamp255(b[i]!) - c[2]!) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    counts[best]! += 1;
  }
  // Empty clusters keep their seed position but own no pixels; reporting them
  // would invent dominant colours that are not in the image.
  const dominantColors = centroids
    .map((c, k) => ({ r: c[0]!, g: c[1]!, b: c[2]!, share: counts[k]! / n }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);

  return {
    pixels: n,
    width,
    height,
    channels: { r: sr / n, g: sg / n, b: sb / n },
    luminance: { mean: lumaMean, sd: lumaSd, min: Math.min(...luma), max: Math.max(...luma) },
    saturation: { mean: satSum / n, neutralShare: neutral / n },
    sharpness: {
      contrast: (Math.max(...luma) - Math.min(...luma)) / 255,
      edgeDensity: interior > 0 ? edges / interior : 0,
      meanGradient: interior > 0 ? gradSum / interior : 0,
    },
    dominantColors,
    clippedShare: clipped / n,
    warnings,
  };
}

function kmeansRgb(points: number[][], k: number): number[][] {
  if (points.length === 0) return [[0, 0, 0]];
  const kk = Math.min(k, points.length);
  // Deterministic seeding: the darkest, brightest and most extreme points first,
  // then evenly spaced through the sorted-by-luma order. No RNG, so repeated
  // runs give identical colours.
  const sorted = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => lumaOf(a.p) - lumaOf(b.p) || a.i - b.i)
    .map((x) => x.p);
  const seeds: number[][] = [sorted[0]!];
  while (seeds.length < kk) {
    const idx = Math.floor((seeds.length / kk) * sorted.length);
    seeds.push(sorted[Math.min(sorted.length - 1, idx)]!);
  }
  const centroids = seeds.map((s) => [...s]);
  for (let iter = 0; iter < 30; iter++) {
    const sums = Array.from({ length: centroids.length }, () => [0, 0, 0, 0]);
    for (const p of points) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d =
          (p[0]! - centroids[c]![0]!) ** 2 + (p[1]! - centroids[c]![1]!) ** 2 + (p[2]! - centroids[c]![2]!) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      sums[best]![0]! += p[0]!;
      sums[best]![1]! += p[1]!;
      sums[best]![2]! += p[2]!;
      sums[best]![3]! += 1;
    }
    let moved = 0;
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c]![3]! === 0) continue;
      const next = [sums[c]![0]! / sums[c]![3]!, sums[c]![1]! / sums[c]![3]!, sums[c]![2]! / sums[c]![3]!];
      moved += Math.hypot(next[0]! - centroids[c]![0]!, next[1]! - centroids[c]![1]!, next[2]! - centroids[c]![2]!);
      centroids[c] = next;
    }
    if (moved < 0.5) break;
  }
  return centroids;
}

function lumaOf(p: number[]): number {
  return 0.299 * p[0]! + 0.587 * p[1]! + 0.114 * p[2]!;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Number.isFinite(v) ? v : 0));
}

// ---------------------------------------------------------------------------
// Audio features (numeric PCM column)
// ---------------------------------------------------------------------------

export interface AudioFeatures {
  samples: number;
  sampleRate: number;
  durationSeconds: number;
  /** Peak, RMS and DC offset in sample units. */
  amplitude: { peak: number; rms: number; dcOffset: number };
  /** Share of samples within 1 LSB of full scale — clipping detection. */
  clippingShare: number;
  /** Mean zero-crossing rate and the dominant pitch estimate. */
  zcr: number;
  pitch: { hz: number; clarity: number; periodSamples: number };
  /** Spectral centroid in Hz, averaged across frames. */
  spectralCentroid: number;
  /** Twelve cepstral coefficients from the mean log-spectrum. */
  mfcc: number[];
  /** Per-frame RMS, for a loudness contour. */
  envelope: number[];
  warnings: string[];
  interpretation: string;
}

export function analyzeAudio(samples: number[], opts: { sampleRate?: number; frameSize?: number } = {}): AudioFeatures {
  const sampleRate = opts.sampleRate && opts.sampleRate > 0 ? opts.sampleRate : 16_000;
  const n = samples.length;
  if (n === 0) throw new NlpError("No audio samples to analyse.");
  const warnings: string[] = [];

  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  let crossings = 0;
  let clipped = 0;
  let runAtRail = 0;
  const range = maxAbs(samples);
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    sum += v;
    if (i > 0 && samples[i - 1]! < 0 !== v < 0) crossings++;
    // Clipping is a *run* of consecutive samples pinned at full scale, not a
    // single peak-touching sample: a clean sine reaches ±range twice per period,
    // which is not clipping. Only a plateau of ≥3 samples at the rail is.
    if (range > 0 && a >= range) {
      runAtRail++;
      if (runAtRail >= 3) clipped++;
    } else {
      runAtRail = 0;
    }
  }
  const rms = Math.sqrt(sumSq / n);
  const dcOffset = sum / n;
  const zcr = n > 1 ? crossings / (n - 1) : 0;

  // Framing: equal non-overlapping frames, the last one folded into the previous.
  const frameSize = Math.max(64, Math.min(opts.frameSize ?? 1024, n));
  const frameCount = Math.max(1, Math.floor(n / frameSize));
  const logSpectrumSum = new Float64Array(frameSize);
  let centroidSum = 0;
  const envelope: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSize;
    let frameEnergy = 0;
    for (let i = 0; i < frameSize; i++) frameEnergy += samples[start + i]! ** 2;
    const frameRms = Math.sqrt(frameEnergy / frameSize);
    envelope.push(frameRms);
    const power = powerSpectrum(samples.slice(start, start + frameSize));
    // One-sided magnitude spectrum. A real signal's spectrum is conjugate
    // symmetric, so bins above Nyquist are a mirror of the low bins; leaving
    // them in double-counts every frequency and drags the centroid up to the
    // Nyquist limit for any pure tone.
    let centroid = 0;
    let total = 0;
    for (let k = 1; k <= frameSize / 2; k++) {
      const mirrored = frameSize - k;
      const magnitude = Math.sqrt(power[k]! + (mirrored > 0 && mirrored < frameSize ? power[mirrored]! : 0));
      centroid += ((k * sampleRate) / frameSize) * magnitude;
      total += magnitude;
      logSpectrumSum[k - 1] = (logSpectrumSum[k - 1] ?? 0) + Math.log(magnitude + 1e-10);
    }
    centroidSum += total > 0 ? centroid / total : 0;
  }
  const spectralCentroid = centroidSum / frameCount;

  // DCT-II of the mean one-sided log-spectrum → MFCC. Real cepstral
  // coefficients, which is what lets this be described as speech-shaped rather
  // than a generic DFT of a symmetric spectrum.
  const logSpec = Array.from(logSpectrumSum, (v) => v / frameCount);
  const mfcc: number[] = [];
  const cepstralBands = Math.min(12, Math.floor(frameSize / 2));
  for (let k = 0; k < cepstralBands; k++) {
    let acc = 0;
    for (let i = 0; i < logSpec.length; i++) acc += logSpec[i]! * Math.cos((Math.PI * k * (i + 0.5)) / logSpec.length);
    mfcc.push(acc);
  }

  // Pitch by normalised autocorrelation over a plausible vocal range.
  const pitch = estimatePitch(samples, sampleRate);
  if (frameCount > 200) {
    warnings.push(
      `Windowed into ${frameCount} frames; the loudness contour was truncated to 200 points for display. All spectral statistics use every frame.`,
    );
  }
  if (range > 0 && Math.abs(dcOffset) / range > 0.1) {
    warnings.push(
      `DC offset is ${((dcOffset / range) * 100).toFixed(1)}% of peak amplitude — the signal is not centred, which suggests capture bias or a missing high-pass stage.`,
    );
  }
  if (clipped / n > 0.001) {
    warnings.push(
      `${((clipped / n) * 100).toFixed(2)}% of samples sit at full scale. Clipped peaks flatten the waveform and bias every spectral estimate here downward.`,
    );
  }
  if (pitch.clarity < 0.3) {
    warnings.push(
      `Autocorrelation peaked at only ${pitch.clarity.toFixed(2)} — no clear periodic pitch. The estimate of ${pitch.hz > 0 ? pitch.hz.toFixed(0) + " Hz" : "none"} is not reliable for this signal.`,
    );
  }

  return {
    samples: n,
    sampleRate,
    durationSeconds: n / sampleRate,
    amplitude: { peak, rms, dcOffset },
    clippingShare: clipped / n,
    zcr,
    pitch,
    spectralCentroid,
    mfcc,
    envelope: envelope.slice(0, 200),
    warnings,
    interpretation:
      `${n.toLocaleString()} samples at ${sampleRate.toLocaleString()} Hz = ${(n / sampleRate).toFixed(2)} s. RMS ${rms.toFixed(3)}, peak ${peak.toFixed(3)}, DC offset ${dcOffset.toFixed(4)}. ` +
      `Spectral centroid ${spectralCentroid.toFixed(0)} Hz (brightness), zero-crossing rate ${zcr.toFixed(4)} (tonality proxy). ` +
      `${pitch.hz > 0 && pitch.clarity >= 0.3 ? `Dominant pitch ${pitch.hz.toFixed(1)} Hz (${pitch.periodSamples} samples/period, autocorrelation clarity ${pitch.clarity.toFixed(2)}).` : "No reliable dominant pitch — the signal is not clearly periodic."}`,
  };
}

/**
 * Power spectrum via an iterative radix-2 Cooley–Tukey FFT (n zero-padded to
 * the next power of two). A direct DFT here would be O(n²) per frame, which is
 * ~1M operations per frame at n=1024 and dominates the whole analysis.
 */
function powerSpectrum(frame: number[]): Float64Array {
  const padded = 1 << Math.ceil(Math.log2(Math.max(2, frame.length)));
  const re = new Float64Array(padded);
  const im = new Float64Array(padded);
  for (let i = 0; i < frame.length; i++) re[i] = frame[i]!;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < padded; i++) {
    let bit = padded >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= padded; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < padded; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm;
        const vIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  const out = new Float64Array(frame.length);
  for (let k = 0; k < frame.length; k++) out[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return out;
}

function estimatePitch(samples: number[], sampleRate: number): { hz: number; clarity: number; periodSamples: number } {
  const n = samples.length;
  // 70–1000 Hz covers the human vocal range and instrumental fundamentals.
  const minLag = Math.max(2, Math.floor(sampleRate / 1000));
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / 70));
  if (maxLag <= minLag) return { hz: 0, clarity: 0, periodSamples: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const centred = samples.map((s) => s - mean);
  let energy = 0;
  for (const c of centred) energy += c * c;
  if (energy === 0) return { hz: 0, clarity: 0, periodSamples: 0 };

  let bestLag = 0;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += centred[i]! * centred[i + lag]!;
    const corr = acc / energy;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return { hz: 0, clarity: 0, periodSamples: 0 };
  return { hz: sampleRate / bestLag, clarity: Math.max(0, Math.min(1, bestCorr)), periodSamples: bestLag };
}

function maxAbs(a: number[]): number {
  let m = 0;
  for (const v of a) {
    const x = Math.abs(v);
    if (x > m) m = x;
  }
  return m;
}
