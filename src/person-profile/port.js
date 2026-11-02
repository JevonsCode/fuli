import { InvalidInputError } from '../app/application-error.js';
import { avatarLook } from '../avatars/look.js';
import { jsonFormat, readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { singleLine } from '../text/single-line.js';

// The person's own home (「我」): what FULI and Agents call them and the
// picture they show as 「我」. Kept on this computer only, in
// person-profile.json under the data directory; only the person changes it,
// in the console (local_user_only). Agents get the name as one short field of
// the preferences they already read (context.address_as), never the picture.
export const PERSON_PROFILE_FORMAT = jsonFormat({ store: 'person-profile', versions: [1] });
const PERSON_NAME_MAX_CHARS = 32;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const VERSION_LENGTH = 16;
const DEFAULT_LOOK = Object.freeze({ kind: 'default' });

export function createPersonProfile({ path, now = () => new Date() }) {
  // A file this FULI cannot read reads as nothing chosen; writing replaces it,
  // and the format guard still refuses one a newer FULI wrote.
  const current = () => {
    const record = readJsonRecord(path, PERSON_PROFILE_FORMAT);
    return record?.version ? record : null;
  };

  return Object.freeze({
    view: () => view(current()),

    // What Agents call the person; '' when they never said.
    addressAs: () => current()?.name ?? '',

    // Changes the name, the look or both; a field left out stays as it is.
    update(input) {
      const changes = {
        ...(input?.name !== undefined ? { name: personName(input.name) } : {}),
        ...(input?.look !== undefined ? { look: storedLook(avatarLook(input.look)) } : {})
      };
      if (!Object.keys(changes).length) throw new InvalidInputError('Send name, look or both');
      const saved = updateVersionedJsonFileAtomic(path, PERSON_PROFILE_FORMAT, (record) => ({
        version: 1, name: record?.name ?? '', look: record?.look ?? DEFAULT_LOOK, ...changes,
        updatedAt: now().toISOString()
      }), { read: current });
      return view(saved);
    },

    // The uploaded picture the person shows now, or null when they show none.
    image() {
      const look = current()?.look;
      if (look?.kind !== 'image') return null;
      return { bytes: Buffer.from(look.data, 'base64'), mediaType: look.mediaType,
        version: look.sha256.slice(0, VERSION_LENGTH) };
    }
  });
}

function personName(value) {
  if (typeof value !== 'string') throw new InvalidInputError('name is plain text');
  const name = singleLine(value);
  if ([...name].length > PERSON_NAME_MAX_CHARS) {
    throw new InvalidInputError(`name is at most ${PERSON_NAME_MAX_CHARS} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) throw new InvalidInputError('name is plain text');
  return name;
}

function storedLook({ kind, seed, image }) {
  if (kind === 'generated') return { kind, seed };
  if (kind === 'image') return { kind, mediaType: image.mediaType, sha256: image.sha256, data: image.bytes.toString('base64') };
  return DEFAULT_LOOK;
}

function view(record) {
  const look = record?.look ?? DEFAULT_LOOK;
  return {
    name: record?.name ?? '',
    look: look.kind === 'generated' ? { kind: 'generated', seed: look.seed }
      : look.kind === 'image' ? { kind: 'image', imageVersion: look.sha256.slice(0, VERSION_LENGTH) } : DEFAULT_LOOK,
    updatedAt: record?.updatedAt ?? null
  };
}
