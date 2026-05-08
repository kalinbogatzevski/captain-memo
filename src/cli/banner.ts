import { cyan, cyanBold, cyanDim, dim, goldBold } from '../shared/ansi.ts';

// The anchor glyph (⚓ U+2693) renders 2 columns wide on most terminals.
// Art is drawn assuming that — single-col terminals will look slightly skewed
// but still recognisable.
const ART = (): string[] => [
  '            __________',
  goldBold(  '           / ⚓ ⚓ ⚓ \\'),
  '          /___________\\',
  cyan(      '          |  ●      ●  |'),
  cyan(      '          |      ▽     |'),
  cyan(      '          |  \\______/  |'),
  cyanDim(   '          | ▒▒▒▒▒▒▒▒▒  |'),
  cyanDim(   '           \\▒▒▒▒▒▒▒▒▒▒/'),
  cyanDim(   '            \\▒▒▒▒▒▒▒▒/'),
  cyanDim(   '             \\______/'),
];

export function bannerLines(version = ''): string[] {
  const lines: string[] = ['', ...ART(), ''];
  lines.push(cyanBold('          ⚓  C A P T A I N   M E M O  ⚓'));
  lines.push(dim(     '       The Ship-Log for Your Digital World'));
  if (version) lines.push(dim(`                       ${version}`));
  lines.push('');
  return lines;
}

export function printBanner(version = ''): void {
  console.log(bannerLines(version).join('\n'));
}

export function printMiniBanner(): void {
  console.log('');
  console.log(cyanBold('⚓  Captain Memo') + dim('   ·   The Ship-Log for Your Digital World'));
  console.log('');
}
