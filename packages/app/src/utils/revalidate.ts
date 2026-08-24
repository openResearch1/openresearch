export async function settle<T>(version: () => number, load: () => Promise<T>, retries = 2, delay = 50) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = version()
    const value = await load()
    if (current === version()) return value
    if (attempt < retries && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }
}
