import {
  Architects_Daughter,
  DM_Sans,
  Fira_Code,
  Geist,
  Geist_Mono,
  Instrument_Sans,
  Inter,
  JetBrains_Mono,
  Merriweather,
  Mulish,
  Playfair_Display,
  Noto_Sans_Mono,
  Outfit,
  Space_Mono
} from 'next/font/google';

import { cn } from '@/lib/utils';

/**
 * Font cho app.
 *
 * Hai điểm đã sửa, cùng một nguyên nhân gốc:
 *
 * 1. **Tên family bị hash.** `next/font` nạp font dưới tên như
 *    `__Geist_a1b2c3`, nên các file theme ghi `--font-sans: Geist, sans-serif`
 *    KHÔNG khớp được font đã tải — cả 14 font tải về mà không font nào áp dụng,
 *    toàn UI rơi về font hệ thống. Mỗi font giờ phơi ra một biến CSS riêng và
 *    theme phải trỏ qua `var(...)`, không viết tên thuần.
 *
 * 2. **Không font nào có glyph tiếng Việt.** Subset `latin` không chứa
 *    `ế ộ ữ ậ`, và `latin-ext` cũng chỉ phủ một phần. Riêng Geist / Geist Mono /
 *    Instrument Sans / DM Sans / Fira Code / Outfit / Architects Daughter thì
 *    Google **không phát hành** subset `vietnamese`, nên không thể "bật" thêm.
 *    Cách xử lý: khai báo subset `vietnamese` ở những font có hỗ trợ, rồi đặt
 *    chúng làm bước fallback NGAY TRƯỚC generic family. Trình duyệt chọn font
 *    theo từng glyph, nên chữ Latin vẫn đúng font của theme còn chữ có dấu rơi
 *    vào một webfont đã tải sẵn thay vì một font hệ thống bất định.
 */

// --- Có subset vietnamese: dùng làm lớp fallback cho chữ có dấu ---
const fontMulish = Mulish({ subsets: ['latin', 'vietnamese'], variable: '--font-mullish' });
const fontInter = Inter({ subsets: ['latin', 'vietnamese'], variable: '--font-inter' });
const fontJetBrainsMono = JetBrains_Mono({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-jetbrains-mono',
  display: 'swap'
});
const fontNotoMono = Noto_Sans_Mono({ subsets: ['latin', 'vietnamese'], variable: '--font-noto-mono' });
const fontSpaceMono = Space_Mono({ subsets: ['latin', 'vietnamese'], weight: ['400', '700'], variable: '--font-space-mono' });
const fontMerriweather = Merriweather({ subsets: ['latin', 'vietnamese'], weight: ['300', '400', '700'], variable: '--font-merriweather' });
const fontPlayfairDisplay = Playfair_Display({ subsets: ['latin', 'vietnamese'], variable: '--font-playfair-display' });

// --- Không có subset vietnamese: chỉ phủ Latin, dựa vào fallback ở trên ---
const fontGeist = Geist({ subsets: ['latin', 'latin-ext'], variable: '--font-geist' });
const fontGeistMono = Geist_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-geist-mono' });
const fontInstrument = Instrument_Sans({ subsets: ['latin', 'latin-ext'], variable: '--font-instrument' });
const fontDMSans = DM_Sans({ subsets: ['latin', 'latin-ext'], variable: '--font-dm-sans' });
const fontFiraCode = Fira_Code({ subsets: ['latin', 'latin-ext'], variable: '--font-fira-code' });
const fontOutfit = Outfit({ subsets: ['latin', 'latin-ext'], variable: '--font-outfit' });
const fontArchitectsDaughter = Architects_Daughter({ subsets: ['latin'], weight: '400', variable: '--font-architects-daughter' });

export const fontVariables = cn(
  fontMulish.variable,
  fontInter.variable,
  fontJetBrainsMono.variable,
  fontNotoMono.variable,
  fontSpaceMono.variable,
  fontMerriweather.variable,
  fontPlayfairDisplay.variable,
  fontGeist.variable,
  fontGeistMono.variable,
  fontInstrument.variable,
  fontDMSans.variable,
  fontFiraCode.variable,
  fontOutfit.variable,
  fontArchitectsDaughter.variable
);
