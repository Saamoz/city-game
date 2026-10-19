import type { IsoTimestamp, Uuid } from './types.js';

// The final clue: the admin uploads a few candidate pictures before the game, the server secretly
// picks one at game start, and each completed challenge hands its team one fragment of it. A picture
// is cut into one fragment per challenge in the game's challenge set.
export const CLUE_MAX_FRAGMENT_COUNT = 200;

// Uploaded pictures are scaled down to this on their longest side before they are cut.
export const CLUE_IMAGE_MAX_DIMENSION = 2000;

export interface ClueFragmentRect {
  index: number;
  // Fractions of the whole picture, 0..1.
  x: number;
  y: number;
  width: number;
  height: number;
}

// Cuts a picture into `count` tiles laid out like bricks: equal-height rows, each split into
// equal-width tiles, with the row count chosen so the tiles come out as close to square as possible.
export function getClueFragmentRects(imageWidth: number, imageHeight: number, count: number): ClueFragmentRect[] {
  const aspect = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
  let bestRows: number[] = [count];
  let bestScore = Infinity;

  for (let rowCount = 1; rowCount <= count; rowCount += 1) {
    const rows = distributeTiles(count, rowCount);
    // A tile in a row of n is (aspect / n) wide for every (1 / rowCount) tall.
    const score = rows.reduce((sum, n) => sum + n * Math.abs(Math.log((aspect / n) * rowCount)), 0);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      bestRows = rows;
    }
  }

  const rects: ClueFragmentRect[] = [];
  bestRows.forEach((tilesInRow, rowIndex) => {
    for (let column = 0; column < tilesInRow; column += 1) {
      rects.push({
        index: rects.length,
        x: column / tilesInRow,
        y: rowIndex / bestRows.length,
        width: 1 / tilesInRow,
        height: 1 / bestRows.length,
      });
    }
  });
  return rects;
}

// Spreads `count` tiles over `rowCount` rows, alternating the longer rows so the bricks stagger.
function distributeTiles(count: number, rowCount: number): number[] {
  const base = Math.floor(count / rowCount);
  const extra = count % rowCount;
  const offset = Math.floor(rowCount / 2);
  const extrasBefore = (row: number) => Math.floor((row * extra + offset) / rowCount);
  return Array.from({ length: rowCount }, (_, row) => base + extrasBefore(row + 1) - extrasBefore(row));
}

// What the admin panel sees. It never says which picture was chosen.
export interface ClueImageSummary {
  id: Uuid;
  width: number;
  height: number;
  fragmentCount: number;
  thumbnail: string;
  createdAt: IsoTimestamp;
}

export interface AdminClueStatus {
  // How many fragments a new picture needs: the number of challenges in the game's set, or null
  // when the game has no set (and so can't have a clue).
  fragmentCount: number | null;
  images: ClueImageSummary[];
  isChosen: boolean;
  foundFragmentCount: number;
  revealedAt: IsoTimestamp | null;
}

export interface ClueFragment {
  index: number;
  url: string;
  challengeTitle: string | null;
  teamIds: Uuid[];
}

// What a team sees: its own fragments, or every team's once the admin reveals them.
export interface TeamClue {
  width: number;
  height: number;
  fragmentCount: number;
  revealedAt: IsoTimestamp | null;
  fragments: ClueFragment[];
}

export interface ClueImageUpload {
  width: number;
  height: number;
  thumbnail: string;
  tiles: string[];
}
