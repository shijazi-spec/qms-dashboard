// Auto-generated from CRM_Users_Complete_134 (2026-04-19). Do not edit by hand;
// re-run the roster import if owners change. See docs/WalaPlus_Platform_SOP.md §11 (Owner Roster).
export interface SeedUser {
  name: string;
  team: string;
  status: 'Active' | 'Inactive';
  totalRecords: number;
  modules: string[];
}

// Name aliases — CRM stores the same person under multiple spellings; map alias -> canonical.
// Keys are normalized (lowercased, single-spaced); values must match a SeedUser.name above.
export const NAME_ALIASES: Record<string, string> = {
  'rayan': 'Rayan Saleh',
  'abdulmajeed alshabili': 'Abdulmajed Alshabili',
};

const normalize = (s: string): string =>
  (s || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();

let _index: Map<string, SeedUser> | null = null;
function buildIndex(): Map<string, SeedUser> {
  if (_index) return _index;
  const idx = new Map<string, SeedUser>();
  for (const u of SEED_USERS) idx.set(normalize(u.name), u);
  for (const [aliasRaw, canonicalRaw] of Object.entries(NAME_ALIASES)) {
    const canonical = idx.get(normalize(canonicalRaw));
    if (canonical) idx.set(normalize(aliasRaw), canonical);
  }
  _index = idx;
  return idx;
}

export function findSeedUser(name: string): SeedUser | undefined {
  if (!name) return undefined;
  return buildIndex().get(normalize(name));
}

export const SEED_USERS: SeedUser[] = [
  { name: 'A Alsharif', team: 'WPE', status: 'Active', totalRecords: 4, modules: ['Contacts', 'Accounts'] },
  { name: 'Abdallah Alsheikh', team: 'CRM Admin', status: 'Active', totalRecords: 145, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdallah Khorshid', team: 'MP', status: 'Active', totalRecords: 81, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdalrahim Abuwarda', team: 'MP', status: 'Inactive', totalRecords: 39, modules: ['Deals'] },
  { name: 'Abdalrzaq Alshamari', team: 'BD', status: 'Inactive', totalRecords: 30, modules: ['Contacts', 'Accounts'] },
  { name: 'Abdelhamid Said', team: 'WP Sales', status: 'Inactive', totalRecords: 28, modules: ['Contacts', 'Accounts'] },
  { name: 'Abdulaziz Almassad', team: 'WO Sales', status: 'Active', totalRecords: 225, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulaziz Almutairi', team: 'WO Sales', status: 'Inactive', totalRecords: 229, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdullah  Mubarak AlMubarak', team: 'WP Sales', status: 'Inactive', totalRecords: 404, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdullah Alsaeed', team: 'BD', status: 'Inactive', totalRecords: 1, modules: ['Deals'] },
  { name: 'Abdullah Alzalam', team: 'MP', status: 'Active', totalRecords: 7, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdullah Shoeib', team: 'WO Sales', status: 'Inactive', totalRecords: 71, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulmajed Alshabili', team: 'WP Sales', status: 'Inactive', totalRecords: 16, modules: ['Leads', 'Deals'] },
  { name: 'Abdulmalik  M Bin Aifan', team: 'WP Sales', status: 'Inactive', totalRecords: 548, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulmalik Alfaleh', team: 'CS', status: 'Active', totalRecords: 122, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulrahman  Abdulkarimm Alqurashi', team: 'WP Sales', status: 'Active', totalRecords: 377, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulrahman AlFarram', team: 'MP', status: 'Active', totalRecords: 77, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulrahman Alshehri', team: 'WO Sales', status: 'Active', totalRecords: 4, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulrahman Dhafer', team: 'WP Sales', status: 'Active', totalRecords: 375, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abdulrahman Harith', team: 'WP Sales', status: 'Inactive', totalRecords: 2, modules: ['Contacts', 'Accounts'] },
  { name: 'Abdulrhman AlFahad', team: 'WP Sales', status: 'Active', totalRecords: 653, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Abobakr Ali', team: 'MP', status: 'Active', totalRecords: 47, modules: ['Deals'] },
  { name: 'Abubaker Hashem', team: 'MP', status: 'Active', totalRecords: 1486, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'AbuBaker Shams Aldeen', team: 'MP', status: 'Inactive', totalRecords: 2, modules: ['Contacts', 'Accounts'] },
  { name: 'Ahmad Alfheer', team: 'Unassigned', status: 'Inactive', totalRecords: 106, modules: ['Deals'] },
  { name: 'Ahmed Abuamasheh', team: 'MGMT', status: 'Active', totalRecords: 5, modules: ['Contacts', 'Accounts'] },
  { name: 'Ahmed Aldukheel', team: 'Unassigned', status: 'Inactive', totalRecords: 46, modules: ['Deals'] },
  { name: 'Ahmed Alhusaynan', team: 'Unassigned', status: 'Inactive', totalRecords: 2, modules: ['Contacts', 'Accounts'] },
  { name: 'Ahmed Gasim', team: 'WO Sales', status: 'Active', totalRecords: 790, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Ahmed Jabbas', team: 'MP', status: 'Inactive', totalRecords: 4, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Alhanouf  Aldarwish', team: 'CS', status: 'Active', totalRecords: 498, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Ali  AlRajhi', team: 'WP Sales', status: 'Active', totalRecords: 818, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Ali  Chisty', team: 'WO Sales', status: 'Inactive', totalRecords: 11, modules: ['Leads', 'Contacts', 'Accounts'] },
  { name: 'Ali  Hussein Abualhassan', team: 'CS', status: 'Inactive', totalRecords: 3, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Ali BaAusharah', team: 'WO Sales', status: 'Inactive', totalRecords: 5, modules: ['Accounts'] },
  { name: 'Ali Jaafari', team: 'WO Sales', status: 'Active', totalRecords: 2, modules: ['Deals'] },
  { name: 'Alia Altammami', team: 'MP', status: 'Active', totalRecords: 1359, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Aljawharah Almusharraf', team: 'Unassigned', status: 'Inactive', totalRecords: 4, modules: ['Deals'] },
  { name: 'Ameera Alshahri', team: 'BD', status: 'Active', totalRecords: 57, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Amwaj Alotaibi', team: 'WO Sales', status: 'Active', totalRecords: 281, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Anas AlMasoud', team: 'WO Sales', status: 'Inactive', totalRecords: 124, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Ashwaq Alqahtani', team: 'WP Sales', status: 'Inactive', totalRecords: 70, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Awis Kilani', team: 'Unassigned', status: 'Inactive', totalRecords: 9, modules: ['Deals'] },
  { name: 'Ayman AlQahtani', team: 'WP Sales', status: 'Active', totalRecords: 783, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Ayman Talbi', team: 'BD', status: 'Inactive', totalRecords: 8, modules: ['Deals'] },
  { name: 'Bader  Alqahtani', team: 'WP Sales', status: 'Active', totalRecords: 8, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Bander Alaklabi', team: 'WP Sales', status: 'Inactive', totalRecords: 417, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Bashayr  ahmad', team: 'WP Sales', status: 'Active', totalRecords: 844, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Bisher khair', team: 'MP', status: 'Inactive', totalRecords: 2, modules: ['Deals'] },
  { name: 'Bushra alamro', team: 'WP Sales', status: 'Inactive', totalRecords: 316, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Doha  Sadek', team: 'MP', status: 'Active', totalRecords: 133, modules: ['Deals'] },
  { name: 'Donia Hesham', team: 'MP', status: 'Active', totalRecords: 702, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Eid Alahmadi', team: 'MP', status: 'Active', totalRecords: 335, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Engy Magdy', team: 'MP', status: 'Active', totalRecords: 149, modules: ['Deals'] },
  { name: 'Fadi Makhoul', team: 'MP', status: 'Active', totalRecords: 28, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Fahad  Albraiki', team: 'MP', status: 'Inactive', totalRecords: 90, modules: ['Deals'] },
  { name: 'Fahad AlGhunaim', team: 'CS', status: 'Inactive', totalRecords: 1, modules: ['Accounts'] },
  { name: 'Fahad BinHaqan', team: 'WP Sales', status: 'Inactive', totalRecords: 17, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Faisal Alaskar', team: 'Unassigned', status: 'Inactive', totalRecords: 2, modules: ['Contacts', 'Accounts'] },
  { name: 'GOV  WalaPlus', team: 'WP Sales', status: 'Inactive', totalRecords: 38, modules: ['Deals'] },
  { name: 'HAMAD ALESSA', team: 'WP Sales', status: 'Inactive', totalRecords: 2, modules: ['Deals'] },
  { name: 'Hassan Tabrizi', team: 'MP', status: 'Active', totalRecords: 79, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Hayat  Abu ElKassem', team: 'MP', status: 'Inactive', totalRecords: 95, modules: ['Deals', 'Contacts'] },
  { name: 'Hossam AlTamimi', team: 'MP', status: 'Inactive', totalRecords: 995, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Hussain Ali', team: 'MP', status: 'Inactive', totalRecords: 197, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Hussain Nooraldeen', team: 'MP', status: 'Active', totalRecords: 1179, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Ibrahim Qahtan', team: 'WO Sales', status: 'Inactive', totalRecords: 328, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Jameel Douglas', team: 'MP', status: 'Inactive', totalRecords: 459, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Kareem Elhosany', team: 'WP Sales', status: 'Active', totalRecords: 690, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Khaled Alharbi', team: 'WP Sales', status: 'Inactive', totalRecords: 187, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Khalid Alkhowaiter', team: 'WO Sales', status: 'Inactive', totalRecords: 170, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Khalid AlMangour', team: 'WO Sales', status: 'Inactive', totalRecords: 394, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Khalil Aldadah', team: 'MP', status: 'Inactive', totalRecords: 282, modules: ['Deals'] },
  { name: 'Khowla Saeed', team: 'WP Sales', status: 'Active', totalRecords: 940, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Maged Adel', team: 'WP Sales', status: 'Inactive', totalRecords: 2, modules: ['Contacts', 'Accounts'] },
  { name: 'Majed Bamukideh', team: 'MP', status: 'Active', totalRecords: 67, modules: ['Leads', 'Deals'] },
  { name: 'Mansoor Kadir', team: 'Unassigned', status: 'Inactive', totalRecords: 14, modules: ['Contacts', 'Accounts'] },
  { name: 'Mansour Alqahtani', team: 'WP Sales', status: 'Active', totalRecords: 781, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Maria Blioju', team: 'MP', status: 'Active', totalRecords: 21, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Meznah Alharthi', team: 'Unassigned', status: 'Inactive', totalRecords: 230, modules: ['Deals'] },
  { name: 'Moaz  Al Sahhar', team: 'MP', status: 'Active', totalRecords: 82, modules: ['Contacts', 'Accounts'] },
  { name: 'Mohamed AlSaleh', team: 'MP', status: 'Active', totalRecords: 1256, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Mohamed Khreis', team: 'MP', status: 'Active', totalRecords: 102, modules: ['Deals'] },
  { name: 'Mohammed Alhumoudi', team: 'CS', status: 'Active', totalRecords: 1, modules: ['Leads'] },
  { name: 'Mohammed Alrudaini', team: 'MP', status: 'Active', totalRecords: 52, modules: ['Deals'] },
  { name: 'Mohammed Alsudani', team: 'WO Sales', status: 'Active', totalRecords: 608, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Mohammed Alzahrani', team: 'WP Sales', status: 'Inactive', totalRecords: 296, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Mohammed Edwan', team: 'MP', status: 'Active', totalRecords: 503, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Mohammed Fouad', team: 'MRK', status: 'Active', totalRecords: 1, modules: ['Deals'] },
  { name: 'Mohammed Ghanem', team: 'BD', status: 'Inactive', totalRecords: 413, modules: ['Deals'] },
  { name: 'Mohammed Qasem', team: 'MRK', status: 'Active', totalRecords: 3, modules: ['Leads'] },
  { name: 'Mohammed Ridha', team: 'MRK', status: 'Inactive', totalRecords: 10, modules: ['Leads'] },
  { name: 'Mostafa Elzohairy', team: 'MP', status: 'Active', totalRecords: 10, modules: ['Deals'] },
  { name: 'Muteb Albdrani', team: 'WO Sales', status: 'Inactive', totalRecords: 55, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Nada Bin Salman', team: 'SDR', status: 'Active', totalRecords: 1, modules: ['Leads'] },
  { name: 'Naif Almutairi', team: 'WP Sales', status: 'Inactive', totalRecords: 4, modules: ['Contacts', 'Accounts'] },
  { name: 'Naif AlSaif', team: 'WP Sales', status: 'Inactive', totalRecords: 323, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Nawaf Al Shiban', team: 'WP Sales', status: 'Inactive', totalRecords: 222, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Nawaf alhoshan', team: 'WP Sales', status: 'Active', totalRecords: 1106, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Nawaf Basif', team: 'WP Sales', status: 'Inactive', totalRecords: 2, modules: ['Deals'] },
  { name: 'Nawras', team: 'Unassigned', status: 'Inactive', totalRecords: 7, modules: ['Deals'] },
  { name: 'Noha AlZaben', team: 'WP Sales', status: 'Inactive', totalRecords: 233, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Noura AlMuneef', team: 'Unassigned', status: 'Inactive', totalRecords: 15, modules: ['Accounts'] },
  { name: 'Obadah Khaled', team: 'WO Sales', status: 'Active', totalRecords: 126, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Osama Harfoush', team: 'MGMT', status: 'Active', totalRecords: 1, modules: ['Accounts'] },
  { name: 'Rayan Saleh', team: 'MGMT', status: 'Active', totalRecords: 3, modules: ['Leads', 'Contacts', 'Accounts'] },
  { name: 'Reda Saleh', team: 'MP', status: 'Active', totalRecords: 964, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'Saad Almalki', team: 'WP Sales', status: 'Inactive', totalRecords: 518, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Salman  Ali Mohammed Aloref', team: 'WP Sales', status: 'Inactive', totalRecords: 602, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Salman AlIssa', team: 'CS', status: 'Active', totalRecords: 50, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Samar Mansour', team: 'MP', status: 'Active', totalRecords: 63, modules: ['Deals'] },
  { name: 'Sarah Hijazi', team: 'MGMT', status: 'Active', totalRecords: 7, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Sultan Alrefaei', team: 'MP', status: 'Active', totalRecords: 195, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Sultan Banajah', team: 'Unassigned', status: 'Inactive', totalRecords: 514, modules: ['Leads', 'Deals'] },
  { name: 'Tamim Alajlan', team: 'WP Sales', status: 'Inactive', totalRecords: 305, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Thamer  Alsuhaibani', team: 'WO Sales', status: 'Inactive', totalRecords: 1, modules: ['Deals'] },
  { name: 'Wafaa Alqudaiy', team: 'WP Sales', status: 'Active', totalRecords: 859, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'WalaPlus', team: 'WP Sales', status: 'Inactive', totalRecords: 14, modules: ['Deals', 'Accounts'] },
  { name: 'waseem albalawi', team: 'Unassigned', status: 'Inactive', totalRecords: 11, modules: ['Deals'] },
  { name: 'Yahya Alshehri', team: 'WP Sales', status: 'Active', totalRecords: 846, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'zahrah alnasser', team: 'Unassigned', status: 'Inactive', totalRecords: 149, modules: ['Deals'] },
  { name: 'Zaid Alholaibah', team: 'WP Sales', status: 'Inactive', totalRecords: 66, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Zeina  Mamdouh', team: 'CS', status: 'Active', totalRecords: 30, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'Ziad Abbas', team: 'WP Sales', status: 'Active', totalRecords: 8, modules: ['Contacts', 'Accounts'] },
  { name: 'بشاير القحطاني', team: 'SDR', status: 'Active', totalRecords: 3108, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'تغريد الجاسر', team: 'Eitmad', status: 'Active', totalRecords: 588, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'ريان السماك', team: 'SDR', status: 'Inactive', totalRecords: 718, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'شهد الزيد', team: 'SDR', status: 'Inactive', totalRecords: 471, modules: ['Leads', 'Contacts', 'Accounts'] },
  { name: 'صالح الحمدّي', team: 'CS', status: 'Active', totalRecords: 211, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'عبدالمجيد الشبيلي', team: 'WP Sales', status: 'Inactive', totalRecords: 193, modules: ['Contacts', 'Accounts'] },
  { name: 'فايز الأسمري', team: 'WP Sales', status: 'Active', totalRecords: 1141, modules: ['Deals', 'Contacts', 'Accounts'] },
  { name: 'فايزة العتيبي', team: 'SDR', status: 'Active', totalRecords: 1387, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'نوف العاصمي', team: 'SDR', status: 'Inactive', totalRecords: 1335, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
  { name: 'هاجر الحبردي', team: 'SDR', status: 'Active', totalRecords: 1866, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
];
