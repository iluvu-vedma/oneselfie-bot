/** Печатает все экраны сценария — чтобы вычитать копирайт, не поднимая бота. */
import { SPARKS_PER_IMAGE, PACKAGES } from "../src/config";
import {
  T,
  beginKeyboard,
  doneKeyboard,
  generateKeyboard,
  paywallKeyboard,
} from "../src/ui";
import { InlineKeyboard } from "grammy";

function screen(step: string, text: string, kb?: InlineKeyboard) {
  console.log(`\n── ${step} ${"─".repeat(Math.max(0, 60 - step.length))}`);
  console.log(text);
  if (kb) for (const row of kb.inline_keyboard) console.log(`  [ ${row.map((b: any) => b.text).join(" | ")} ]`);
}

screen("2. Что будет (+ картинка-пример)", T.intro, beginKeyboard());
screen("3. Просьба о селфи", T.askPhotos);
screen("3. Принято фото", T.photoAccepted(2), doneKeyboard());
screen("3. Пятое фото", T.photoEnough);
screen("4. Пейволл", T.paywall, paywallKeyboard());
screen("5. После оплаты", T.paid(PACKAGES.set.sparks, 180), generateKeyboard());
screen("6. Экран кадра", T.ready(180), generateKeyboard());
screen("6. Нажали", T.generating);
screen("7. Под кадром", T.ready(168), generateKeyboard());
screen("8. Искр не хватает", T.notEnough(0), paywallKeyboard());
screen("Провал генерации", T.refunded(SPARKS_PER_IMAGE), generateKeyboard());
screen("Три неудачи подряд", T.repeatedFails);
screen("9. /new", T.photosReset);
screen("10. /balance", T.balance(180), generateKeyboard());
console.log("");
