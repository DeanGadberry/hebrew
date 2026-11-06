// Naming and tagging shared by the page (app.js) and the command-line tagger
// (scripts/tag.mjs), so files look the same however they were fetched.

import { MEDIA_KIND } from './remux.js';

// Rough sizes of what Lets.Church serves, in MB per minute (for estimates only).
export const QUALITY = {
  VIDEO_1080P: { label: '1080p', mbPerMin: 38, ext: 'm4v', hd: 2 },
  VIDEO_4K: { label: '4K', mbPerMin: 140, ext: 'm4v', hd: 3 },
  AUDIO: { label: 'audio', mbPerMin: 1.3, ext: 'm4a', hd: null },
  // Lessons Lets.Church lacks come from the Internet Archive as a single 720p file…
  ARCHIVE: { label: '720p', mbPerMin: 7, ext: 'm4v', hd: 1 },
  // …or from the creators' torrent (fetched by the "Fetch missing lessons" workflow).
  TORRENT: { label: '1080p', mbPerMin: 20, ext: 'm4v', hd: 2 },
};

// What actually gets downloaded for an episode at the chosen quality.
export function qualityFor(ep, quality) {
  if (ep.source === 'archive') return 'ARCHIVE';
  if (ep.source === 'torrent') return 'TORRENT';
  return quality;
}

export function pad(n, width) { return String(n).padStart(width, '0'); }

// Files are numbered for the TV app by the course order (catalog.tvSeasons):
// season 1 "Course" interleaves lessons, review games and stories the way the
// creators sequence them, whatever way the page is being browsed.
export function tvPlace(catalog, ep) {
  if (ep.tvSeason && catalog.tvSeasons) {
    return { season: catalog.tvSeasons.find((s) => s.number === ep.tvSeason), number: ep.tvSeason, episode: ep.tvEpisode };
  }
  return { season: catalog.seasons.find((s) => s.number === ep.season), number: ep.season, episode: ep.episode };
}

export function episodeFilename(catalog, ep, requested) {
  const quality = qualityFor(ep, requested);
  const place = tvPlace(catalog, ep);
  const width = Math.max(2, String(place.season.count).length);
  // ASCII only: some browsers drop the whole name otherwise. The tags keep the full title.
  const safe = ep.title
    .replace(/[\u2013\u2014\u05be]/g, '-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/(\s*-\s*)+$/, '')
    .replace(/(\s+-)+\s+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${catalog.show} - S${pad(place.number, 2)}E${pad(place.episode, width)} - ${safe}.${QUALITY[quality].ext}`;
}

export function episodeMetadata(catalog, ep, requested) {
  const quality = qualityFor(ep, requested);
  const place = tvPlace(catalog, ep);
  const season = place.season;
  const show = catalog.show;
  const common = {
    title: ep.title,
    artist: show,
    albumArtist: show,
    genre: 'Education',
    date: ep.publishedAt || undefined,
    description: ep.description || undefined,
    longDescription: ep.longDescription || ep.description || undefined,
    copyright: 'Public domain — freely given (Matt 10:8)',
    encoder: 'Aleph with Beth Offline',
  };
  if (quality === 'AUDIO') {
    return { ...common, mediaKind: MEDIA_KIND.music, album: `${show} – ${season.name}`, track: place.episode, trackTotal: season.count, comment: ep.description || undefined };
  }
  return {
    ...common,
    mediaKind: MEDIA_KIND.tvShow,
    album: `${show}, ${season.name}`,
    show,
    showSort: show,
    season: place.number,
    episode: place.episode,
    episodeId: ep.label || `S${pad(place.number, 2)}E${pad(place.episode, 3)}`,
    hdVideo: QUALITY[quality].hd,
  };
}
