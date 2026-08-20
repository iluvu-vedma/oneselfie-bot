import { PROMPT_PREFIX, PROMPT_SUFFIX } from "./config";

/**
 * Пул сценариев. Идут по кругу в фиксированном порядке — соседние кадры
 * намеренно не похожи друг на друга (студия / улица / интерьер / свет).
 * Пользователь их не видит, не выбирает и не может запросить конкретный.
 */
export const SCENES: string[] = [
  "Studio headshot against a deep charcoal seamless backdrop, one large softbox from camera left, subject in a plain black crew-neck t-shirt, calm confident expression, tight head-and-shoulders crop",
  "Walking on a city street at golden hour, warm low sun flaring behind the subject, denim jacket over a white tee, blurred shopfronts in the background, candid half-turn toward camera",
  "Corporate portrait in a modern glass-walled office, soft daylight from a floor-to-ceiling window, navy blazer over a light shirt, arms relaxed, clean neutral background",
  "Seated at a cafe window table, soft overcast daylight, oatmeal knit sweater, a cup of coffee on the marble table, warm wooden interior blurred behind",
  "High-key studio portrait on a warm beige backdrop, even flattering light from a large octabox, crisp white shirt, arms loosely crossed, relaxed smile",
  "Night city street, out-of-focus neon signage behind, black leather jacket, cinematic teal and magenta colour grade, rain-slick pavement reflections",
  "Rooftop terrace at blue hour, city skyline with lit windows behind, light grey wool coat, cool ambient light with a warm rim from a nearby lamp",
  "Bright loft interior full of green plants, soft north-facing window light, unbuttoned linen shirt over a tee, leaning against a white brick wall",
  "Dramatic black-and-white studio portrait, single hard key light from the side carving deep shadow, plain dark shirt, intense direct gaze",
  "Autumn park path, dappled sunlight through yellow leaves, camel wool coat and a soft scarf, warm golden bokeh, hands in pockets",
  "In a warm-lit library between tall bookshelves, tungsten lamp glow, olive button-down shirt with rolled sleeves, seated in a leather armchair",
  "On a beach at sunset, sea breeze moving the hair, open-collar white linen shirt, warm orange sky and soft ocean bokeh behind",
  "Against a raw concrete wall, cool flat overcast light, grey hoodie, minimal industrial mood, straight-on symmetrical composition",
  "Formal evening event, black tuxedo jacket, warm chandelier bokeh filling the background, shallow depth of field, poised expression",
  "Morning kitchen scene, soft diffused daylight, plain white t-shirt, holding a ceramic mug, light wooden cabinets softly out of focus",
  "Gym interior with moody directional side light, dark athletic top, a towel over one shoulder, low-key contrast, faint equipment silhouettes behind",
  "In an art gallery with tall white walls, soft even ceiling light, minimal all-black outfit, a blurred large canvas in the far background",
  "Snowy city street in winter, cold blue daylight, heavy wool coat with the collar up, faint breath in the cold air, soft falling snowflakes",
  "Studio portrait on a saturated red backdrop, coloured gel lighting with a cyan rim from behind, black turtleneck, editorial fashion mood",
  "Vintage film-look portrait, warm grain and slightly faded colours, brown corduroy jacket, weathered red brick wall, late afternoon side light",
  "Standing by a floor-to-ceiling airport terminal window, aircraft on the apron behind, casual travel outfit with a backpack strap on one shoulder, cool daylight",
  "In a vineyard at golden hour, long rows of vines receding behind, light chambray shirt with sleeves rolled up, warm backlight and dust in the air",
  "Studio profile portrait, strong rim light separating the silhouette from a near-black background, plain black top, looking away from camera",
  "Beside a rain-covered window, water droplets on the glass, soft grey diffused light, dark knit jumper, contemplative mood, muted colours",
  "Warm tungsten-lit recording studio, headphones resting around the neck, acoustic foam panels blurred behind, dark shirt, relaxed posture",
  "Mountain viewpoint on a clear day, crisp high-altitude daylight, technical shell jacket, wide vista of ridgelines softly out of focus behind",
  "Inside a restaurant at night, warm candlelight on the face, smart casual shirt, deep amber bokeh from the room behind, intimate close crop",
  "Full-body editorial shot on a white cyclorama, clean fashion lighting with a soft shadow on the floor, tailored beige suit, confident stance",
  "Old European alley with warm stone walls, late afternoon sun spilling down the street, crisp white shirt, hands in pockets, warm shadows",
  "Home office at dusk, cool monitor glow on one side of the face and a warm desk lamp on the other, casual shirt, softly lit room behind",
];

/** Собирает финальный промпт для сценария по индексу. */
export function buildPrompt(sceneIndex: number): string {
  const scene = SCENES[sceneIndex % SCENES.length];
  return `${PROMPT_PREFIX} ${scene}. ${PROMPT_SUFFIX}`;
}
