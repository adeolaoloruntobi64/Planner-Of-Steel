import pLimit from 'p-limit';
import { fetchCourseInfo, type CourseInfo } from './calendar';

const cache = new Map<string, CourseInfo>();
const limit = pLimit(6);

export async function getCourseInfo(code: string): Promise<CourseInfo> {
  const key = code.toUpperCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const info = await fetchCourseInfo(key);
  cache.set(key, info);
  return info;
}

export async function warmCache(codes: string[]): Promise<{ warmed: string[]; failed: { code: string; error: string }[] }> {
  const warmed: string[] = [];
  const failed: { code: string; error: string }[] = [];

  await Promise.all(
    codes.map((code) =>
      limit(async () => {
        try {
          await getCourseInfo(code);
          warmed.push(code.toUpperCase());
        } catch (err) {
          failed.push({ code: code.toUpperCase(), error: err instanceof Error ? err.message : String(err) });
        }
      })
    )
  );

  return { warmed, failed };
}

export function cacheStatus(): { size: number; codes: string[] } {
  return { size: cache.size, codes: [...cache.keys()].sort() };
}
