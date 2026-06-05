import parseRange from "range-parser";

export interface Env {
  // R2 bucket bindings are accessed dynamically via env[bindingName].
  // Binding names follow the convention: <PREFIX>_BUCKET (e.g. BLOG_BUCKET, MOMENT_BUCKET).
  // The URL path prefix is uppercased to form the binding name: /blog/... -> BLOG_BUCKET
  [key: string]: unknown;
  ALLOWED_ORIGINS?: string;
  ALLOWED_REFERERS?: string;
  CACHE_CONTROL?: string;
  PATH_PREFIX?: string;
  INDEX_FILE?: string;
  NOTFOUND_FILE?: string;
  DIRECTORY_LISTING?: boolean;
  ITEMS_PER_PAGE?: number;
  HIDE_HIDDEN_FILES?: boolean;
  DIRECTORY_CACHE_CONTROL?: string;
  LOGGING?: boolean;
  R2_RETRIES?: number;
}

const units = ["B", "KB", "MB", "GB", "TB"];

type ParsedRange = { offset: number; length: number } | { suffix: number };

function rangeHasLength(
  object: ParsedRange
): object is { offset: number; length: number } {
  return (<{ offset: number; length: number }>object).length !== undefined;
}

function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return (<R2ObjectBody>object).body !== undefined;
}

function hasSuffix(range: ParsedRange): range is { suffix: number } {
  return (<{ suffix: number }>range).suffix !== undefined;
}

function getRangeHeader(range: ParsedRange, fileSize: number): string {
  return `bytes ${hasSuffix(range) ? fileSize - range.suffix : range.offset}-${
    hasSuffix(range) ? fileSize - 1 : range.offset + range.length - 1
  }/${fileSize}`;
}

/**
 * Hotlink protection: check if the request's Referer is allowed.
 * - If ALLOWED_REFERERS is empty or unset, all requests are allowed.
 * - Requests with no Referer (direct access, bookmarks, curl) are always allowed.
 * - Supports exact domain match and wildcard subdomain (*.example.com).
 */
function isRefererAllowed(
  referer: string | null,
  allowedReferers: string | undefined
): boolean {
  // No config = disabled, allow all
  if (!allowedReferers || allowedReferers === "") return true;
  // No Referer header = direct access, always allow
  if (!referer) return true;

  let refererHost: string;
  try {
    refererHost = new URL(referer).hostname;
  } catch {
    return false;
  }

  const patterns = allowedReferers.split(",").map((s) => s.trim());
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2);
      if (refererHost === domain || refererHost.endsWith("." + domain)) {
        return true;
      }
    } else {
      if (refererHost === pattern) return true;
    }
  }

  return false;
}

/**
 * Dynamically route to the correct R2 bucket based on the first path segment.
 * The binding name is derived by convention: /<prefix>/... -> <PREFIX>_BUCKET
 * e.g. /blog/hello.md  -> env.BLOG_BUCKET with key "hello.md"
 *      /moment/pic.jpg -> env.MOMENT_BUCKET with key "pic.jpg"
 *
 * This means you only need to add a new [[r2_buckets]] in wrangler.toml
 * with binding = "<PREFIX>_BUCKET" and it will be automatically routed.
 */
function getBucket(
  path: string,
  env: Env
): { bucket: R2Bucket; key: string } | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const prefix = segments[0];
  const bindingName = `${prefix.toUpperCase()}_BUCKET`;
  const bucket = env[bindingName];

  if (!bucket) return null;

  return { bucket: bucket as R2Bucket, key: segments.slice(1).join("/") };
}

// some ideas for this were taken from / inspired by
// https://github.com/cloudflare/workerd/blob/main/samples/static-files-from-disk/static.js
async function makeListingResponse(
  path: string,
  bucket: R2Bucket,
  env: Env,
  request: Request
): Promise<Response | null> {
  if (path === "/") path = "";
  else if (path !== "" && !path.endsWith("/")) {
    path += "/";
  }
  let cursor = new URL(request.url).searchParams.get("cursor") || undefined;
  let listing = await bucket.list({
    prefix: path,
    delimiter: "/",
    cursor,
    limit: env.ITEMS_PER_PAGE || 1000,
  });

  if (listing.delimitedPrefixes.length === 0 && listing.objects.length === 0) {
    return null;
  }

  let html: string = "";
  let lastModified: Date | null = null;

  if (request.method === "GET") {
    let htmlList = [];

    if (path !== "") {
      htmlList.push(
        `      <tr>` +
          `<td><a href="../">../</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }

    for (let dir of listing.delimitedPrefixes) {
      if (dir.endsWith("/")) dir = dir.substring(0, dir.length - 1);
      let name = dir.substring(path.length, dir.length);
      if (name.startsWith(".") && env.HIDE_HIDDEN_FILES) continue;
      htmlList.push(
        `      <tr>` +
          `<td><a href="${encodeURIComponent(name)}/">${name}/</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }
    for (let file of listing.objects) {
      let name = file.key.substring(path.length, file.key.length);
      if (name.startsWith(".") && env.HIDE_HIDDEN_FILES) continue;

      let dateStr = file.uploaded.toISOString();
      dateStr = dateStr.split(".")[0].replace("T", " ");
      dateStr = dateStr.slice(0, dateStr.lastIndexOf(":")) + "Z";

      htmlList.push(
        `      <tr>` +
          `<td><a href="${encodeURIComponent(name)}">${name}</a></td>` +
          `<td>${dateStr}</td><td>${niceBytes(file.size)}</td></tr>`
      );

      if (lastModified == null || file.uploaded > lastModified) {
        lastModified = file.uploaded;
      }
    }

    if (listing.truncated) {
      htmlList.push(
        `      <tr>` +
          `<td><a href="?cursor=${listing.cursor}">...see more.../</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }

    if (path === "") path = "/";

    html = `<!DOCTYPE html>
<html>
  <head>
    <title>Index of ${path}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta charset="utf-8">
    <style>
      td { padding-right: 16px; text-align: right; font-family: monospace }
      td:nth-of-type(1) { text-align: left; overflow-wrap: anywhere }
      td:nth-of-type(3) { white-space: nowrap }
      th { text-align: left; }
      @media (prefers-color-scheme: dark) {
        body {
          color: white;
          background-color: #1c1b22;
        }
        a {
          color: #3391ff;
        }
        a:visited {
          color: #C63B65;
        }
      }
    </style>
  </head>
  <body>
    <h1>Index of ${path}</h1>
    <table>
      <tr><th>Filename</th><th>Modified</th><th>Size</th></tr>
${htmlList.join("\n")}
    </table>
  </body>
</html>
  `;
  }

  return new Response(html === "" ? null : html, {
    status: 200,
    headers: {
      "access-control-allow-origin": env.ALLOWED_ORIGINS || "",
      "last-modified": lastModified === null ? "" : lastModified.toUTCString(),
      "content-type": "text/html",
      "cache-control": env.DIRECTORY_CACHE_CONTROL || "no-store",
    },
  });
}

async function retryAsync<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = env.R2_RETRIES || 0;
  let attempts = 0;

  while (maxAttempts == -1 || attempts <= maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempts++;
      if (env.LOGGING) console.error(`Attempt ${attempts} failed:`, err);

      if (attempts <= maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    if (allowedMethods.indexOf(request.method) === -1) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    // Hotlink protection
    const referer = request.headers.get("referer");
    if (
      !isRefererAllowed(referer, env.ALLOWED_REFERERS as string | undefined)
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    let triedIndex = false;

    let response: Response | undefined;

    const isCachingEnabled = env.CACHE_CONTROL !== "no-store";
    const cache = caches.default;
    if (isCachingEnabled) {
      response = await cache.match(request);
    }

    // Since we produce this result from the request, we don't need to strictly use an R2Range
    let range: ParsedRange | undefined;

    if (!response || !(response.ok || response.status == 304)) {
      if (env.LOGGING) {
        console.warn("Cache MISS for", request.url);
      }
      const url = new URL(request.url);
      let fullPath = (env.PATH_PREFIX || "") + decodeURIComponent(url.pathname);

      // Route to the correct bucket based on the first path segment
      if (fullPath.startsWith("/")) fullPath = fullPath.substring(1);
      const routed = getBucket(fullPath, env);
      if (routed === null) {
        return new Response("Not Found: unknown bucket prefix", {
          status: 404,
        });
      }

      const bucket = routed.bucket;
      let path = routed.key;

      // directory logic
      if (path === "" || path.endsWith("/")) {
        // if theres an index file, try that. 404 logic down below has dir fallback.
        if (env.INDEX_FILE && env.INDEX_FILE !== "") {
          path += env.INDEX_FILE;
          triedIndex = true;
        } else if (env.DIRECTORY_LISTING) {
          // return the dir listing
          let listResponse = await makeListingResponse(
            path,
            bucket,
            env,
            request
          );

          if (listResponse !== null) {
            if (listResponse.headers.get("cache-control") !== "no-store") {
              ctx.waitUntil(cache.put(request, listResponse.clone()));
            }
            return listResponse;
          }
        }
      }

      let file: R2Object | R2ObjectBody | null | undefined;

      // Range handling
      if (request.method === "GET") {
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          file = await retryAsync(env, () => bucket.head(path));
          if (file === null)
            return new Response("File Not Found", { status: 404 });
          const parsedRanges = parseRange(file.size, rangeHeader);
          // R2 only supports 1 range at the moment, reject if there is more than one
          if (
            parsedRanges !== -1 &&
            parsedRanges !== -2 &&
            parsedRanges.length === 1 &&
            parsedRanges.type === "bytes"
          ) {
            let firstRange = parsedRanges[0];
            range =
              file.size === firstRange.end + 1
                ? { suffix: file.size - firstRange.start }
                : {
                    offset: firstRange.start,
                    length: firstRange.end - firstRange.start + 1,
                  };
          } else {
            return new Response("Range Not Satisfiable", { status: 416 });
          }
        }
      }

      // Etag/If-(Not)-Match handling
      // R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag
      // This silently ignores invalid or weak (W/) headers
      const getHeaderEtag = (header: string | null) =>
        header?.trim().replace(/^['"]|['"]$/g, "");
      const ifMatch = getHeaderEtag(request.headers.get("if-match"));
      const ifNoneMatch = getHeaderEtag(request.headers.get("if-none-match"));

      const ifModifiedSince = Date.parse(
        request.headers.get("if-modified-since") || ""
      );
      const ifUnmodifiedSince = Date.parse(
        request.headers.get("if-unmodified-since") || ""
      );

      const ifRange = request.headers.get("if-range");
      if (range && ifRange && file) {
        const maybeDate = Date.parse(ifRange);

        if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
          // httpEtag already has quotes, no need to use getHeaderEtag
          if (ifRange.startsWith("W/") || ifRange !== file.httpEtag)
            range = undefined;
        }
      }

      if (ifMatch || ifUnmodifiedSince) {
        file = await retryAsync(env, () =>
          bucket.get(path, {
            onlyIf: {
              etagMatches: ifMatch,
              uploadedBefore: ifUnmodifiedSince
                ? new Date(ifUnmodifiedSince)
                : undefined,
            },
            range,
          })
        );

        if (file && !hasBody(file)) {
          return new Response("Precondition Failed", { status: 412 });
        }
      }

      if (ifNoneMatch || ifModifiedSince) {
        // if-none-match overrides if-modified-since completely
        if (ifNoneMatch) {
          file = await retryAsync(env, () =>
            bucket.get(path, {
              onlyIf: { etagDoesNotMatch: ifNoneMatch },
              range,
            })
          );
        } else if (ifModifiedSince) {
          file = await retryAsync(env, () =>
            bucket.get(path, {
              onlyIf: { uploadedAfter: new Date(ifModifiedSince) },
              range,
            })
          );
        }
        if (file && !hasBody(file)) {
          return new Response(null, { status: 304 });
        }
      }

      file =
        request.method === "HEAD"
          ? await retryAsync(env, () => bucket.head(path))
          : file && hasBody(file)
            ? file
            : await retryAsync(env, () => bucket.get(path, { range }));

      let notFound: boolean = false;

      if (file === null) {
        if (env.INDEX_FILE && triedIndex) {
          // remove the index file since it doesn't exist
          path = path.substring(0, path.length - env.INDEX_FILE.length);
        }

        if (env.DIRECTORY_LISTING && (path.endsWith("/") || path === "")) {
          // return the dir listing
          let listResponse = await makeListingResponse(
            path,
            bucket,
            env,
            request
          );

          if (listResponse !== null) {
            if (listResponse.headers.get("cache-control") !== "no-store") {
              ctx.waitUntil(cache.put(request, listResponse.clone()));
            }
            return listResponse;
          }
        }

        if (env.NOTFOUND_FILE && env.NOTFOUND_FILE != "") {
          notFound = true;
          path = env.NOTFOUND_FILE;
          file =
            request.method === "HEAD"
              ? await retryAsync(env, () => bucket.head(path))
              : await retryAsync(env, () => bucket.get(path));
        }

        // if it's still null, either 404 is disabled or that file wasn't found either
        // this isn't an else because then there would have to be two of them
        if (file == null) {
          return new Response("File Not Found", { status: 404 });
        }
      }

      // Content-Length handling
      let body;
      let contentLength = file.size;
      if (hasBody(file) && file.size !== 0) {
        if (range && !notFound) {
          contentLength = rangeHasLength(range) ? range.length : range.suffix;
        }
        let { readable, writable } = new FixedLengthStream(contentLength);
        file.body.pipeTo(writable);
        body = readable;
      }
      response = new Response(body, {
        status: notFound ? 404 : range ? 206 : 200,
        headers: {
          "accept-ranges": "bytes",
          "access-control-allow-origin": env.ALLOWED_ORIGINS || "",

          etag: notFound ? "" : file.httpEtag,
          // if the 404 file has a custom cache control, we respect it
          "cache-control":
            file.httpMetadata?.cacheControl ??
            (notFound ? "" : env.CACHE_CONTROL || ""),
          expires: file.httpMetadata?.cacheExpiry?.toUTCString() ?? "",
          "last-modified": notFound ? "" : file.uploaded.toUTCString(),

          "content-encoding": file.httpMetadata?.contentEncoding ?? "",
          "content-type":
            file.httpMetadata?.contentType ?? "application/octet-stream",
          "content-language": file.httpMetadata?.contentLanguage ?? "",
          "content-disposition": file.httpMetadata?.contentDisposition ?? "",
          "content-range":
            range && !notFound ? getRangeHeader(range, file.size) : "",
          "content-length": contentLength.toString(),
        },
      });

      if (request.method === "GET" && !range && isCachingEnabled && !notFound)
        ctx.waitUntil(cache.put(request, response.clone()));
    } else {
      if (env.LOGGING) {
        console.warn("Cache HIT for", request.url);
      }
    }

    return response;
  },
};

function niceBytes(x: number) {
  let l = 0,
    n = parseInt(x.toString(), 10) || 0;

  while (n >= 1000 && ++l) {
    n = n / 1000;
  }

  return n.toFixed(n < 10 && l > 0 ? 1 : 0) + " " + units[l];
}
