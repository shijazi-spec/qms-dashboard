/**
 * Audit a PASS domain list against the LIVE preflight engine. For every
 * corporate domain it runs the REAL runPreflight cascade (domain → name) and
 * reports any that come back as anything other than PASS — i.e. a client that
 * leaked into the safe-to-import list. Public / blank domains (#n, gmail,
 * hotmail, …) can't be domain-matched and are listed separately as "skipped".
 *
 *   npx tsx scripts/checkPassDomains.ts
 *
 * Each probe row gets a throwaway example.com email so Rule 1 (contact
 * duplicate) can't fire and the row isn't skipped as name-only — the verdict
 * reflects ONLY the existing-client (domain) check.
 */
import { runPreflight } from "../src/utils/duplicateRadarPreflight";

// The exact PASS "Domain" column pasted by Sarah 2026-06-25.
const RAW = `
#n
19011.tel
maersk.com
alj.com
abdulsamadalqurashi.com
hotmail
abunayyanholding.com
arab-house.com
aitcosa.com
advanced-lines.com
ajapharma.com
balad.com.sa
amoilgas.com
alrajhi-capital.sa
yu.edu.sa
livainsurance.com
alayuni.com
albawani.net
alfaisal.edu
hsalghanim.com
nissan.com.sa
alinma.com
jrac.com.sa
aljabr.com.sa
aljammaz.com
aljaziracapital.com.sa
gmail
mutakamela.sa
almandaryah.com
almeer-saudi.com
almoosacollege.edu.sa
alnafitha.com
alrajhibank.com.sa
amc.edu.sa
yc.com.sa
yemni.com
amana-coop.com.sa
aisr.org
aon.co.uk
arablossadjusters.com
masabik.com
innovation-sa.com
arabio.com
archirodon.net
arodrilling.com
arrowad.org
asmo.com
astellas.com
astrazeneca.com
atkinsrealis.com
aurcontracting.com
شركة أجيالنا التعليمية
bofa.com
baj.com.sa
bankofjordan.com
basserah.com
bcare.com.sa
becsaudi.com
bechtel.com
benchmarktechnology.com
binquraya.com
blackrock.com
bnpparibas.com
bridgestone.ae
alfransi.com.sa
caf.net
cma.org.sa
careem.com
ccc.sa.com
ceermotors.com
cnhi.gov.sa
channels.com.sa
citigroup.com
werecle.com
coe.com.sa
compass-pc.com
continental.com
ctelecoms.com.sa
d360.com
dargroup.com
alameda-hc.com
daralriyadh.com
fikr.edu.sa
darbalwatan.com
dataserve.com.sa
digitrends.pk
directfn.com
dpworld.com
fakeeh.care
drsulaimanalhabib.com
dxc.com
ebttikar.com
ecovisalsabti.com
elsoadaa.com
emiratesnbd.com
energiaksa.com
etsco.sa
enghouse.com.sa
ewpartners.fund
expertindus.com
exxonmobil.com
sa.ey.com
fakeehcomplementary.com
fedex.com
bankfab.com
firstfix-ksa.com
ford.com
fuchsoil.com
gamahospital.com
gasarabian.com
grifolsegyptplasma.com
gsenc.com
gsk.com
gstc.gov.sa
gib.com
flag-logistics.com
hala.com
halliburton.com
hassanallam.com
health.sa
heiscoksa.com
hpinc.com
useholo.com
hsbcsaudi.com
hsbc.com
humain.com
hec.co.kr
ibm.com
icbc.com.cn
ingazco.com
innovationteam.com
itis.com.sa
ipsksa.com
iotsquared.com.sa
jpmorgan.com
jalint.com.sa
jamjoompharma.com
jicollege.edu.sa
jischool.org
jeeny.me
jgc.com
jigpc.com
kabi.ai
kalpataruprojects.com
kaust.edu.sa
kbr.com
khatibalami.com
kau.edu.sa
pnu.edu.sa
kfshrc.edu.sa
kfu.edu.sa
ksu.edu.sa
ksau-hs.edu.sa
lazurde.com
leadergroup.com
leejam.com.sa
levels.sa
lhsc.on.ca
macegroup.com
madaf.com
magrabi.com
saeed-steel.com
mmgroup.com.sa
mapa.group
maximusgulf.com
mcdermott.com
meena-health.com
mermaid-group.com
microsoft.com
mic.com.sa
mc.gov.sa
mcit.gov.sa
mep.gov.sa
moe.gov.sa
moenergy.gov.sa
mof.gov.sa
mim.gov.sa
moj.gov.sa
mt.gov.sa
mot.gov.sa
mobco-group.com
mls.mynaghi.com
mouwasat.com
moyasar.com
myclinic.com.sa
mytm.co
nasco.com.sa
nascosaudi.com
ndmc.gov.sa
sama.gov.sa
infra.gov.sa
ncgr.gov.sa
nec.com
neoleap.com.sa
nesma.com
nesmapartners.com
nokiasaudi.com
ntco.sa
ntgclarity.com
nybl.ai
oscsaudi.com
olayandescon.com
oracle.com
organon.com
pma.ps
petrorabigh.com
petroapp.com
pipecaregroup.com
plat4mation.com
powertower.com.sa
pmu.edu.sa
mbsc.edu.sa
psu.edu.sa
qumc.edu.sa
qehc.edu.sa
trinityholdings.com
redboxsa.com
rgsksa.com
outlook
rewaa.com
rezayat.net
alriyadh.gov.sa
royalcyber.com
rsainsurance.co.uk
saadalessa.com
sabb.com
sabinvest.com
sabamedical.com
usj.edu.lb
saip.gov.sa
salla.sa
sammangroup.com
sanad.com
sanofi.com
sasib.com.sa
saso.gov.sa
sbg.com.sa
scot.gov.sa
scfhs.org.sa
saudico.com.sa
segi.com.sa
saudigeophysical.com
globalpsa.com
sio.gov.sa
sla.edu.sa
spsc.gov.sa
saudireadymix.com.sa
ssem.com.sa
saudisicli.com.sa
saudixerox.com
alibabacloud.sa
sendan.com.sa
sews-e.com
sfda.gov.sa
sgc.it
iptpowertech.com
su.edu.sa
shelfdrilling.com
sajco.com.sa
sicim.eu
sinopec.com
sirar.com.sa
yahoo
slb.com
smebank.gov.sa
solstores.com
solutions.com.sa
spimaco.sa
stengg.com
stcbank.com.sa
sure.com.sa
tabukpharmaceuticals.com
taibahu.edu.sa
tamam.life
tameeni.com
tamergroup.com
tanmiah.gov.sa
tavc.com.tr
tawal.com.sa
techmahindra.com
tecnicasreunidas.es
tenaris.com
tis.edu.sa
taef.com
alahli.com
tiqmo.com
tmf-group.com
totalenergies.com
tdf.gov.sa
urbacon-intl.com
unigaz.net
aup.edu.pk
ubt.edu.sa
uj.edu.sa
upm.edu.sa
ut.edu.sa
v3international.com
vt.edu
v2.com.sa
visionbank.com.sa
waadeducation.edu.sa
wagely.app
wataniya.com.sa
wipro.com
yunitco.com.sa
zamilsteel.com
zomco.com
arabou.edu.sa
ncm.gov.sa
rga.gov.sa
bankalbilad.com
ssp.gov.sa
mu.edu.sa
ffm.gov.sa
moc.gov.sa
`;

function isPublicOrBlank(d: string): boolean {
  const x = d.trim().toLowerCase();
  if (!x || x === "#n") return true;
  if (!x.includes(".")) return true; // "hotmail"/"gmail"/"yahoo"/"outlook" w/o TLD, or a name
  return /^(gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|aol|proton|gmx|mail)\b/.test(x);
}
// A token in the domain column that isn't a domain at all (e.g. an Arabic name).
function looksLikeName(d: string): boolean {
  const x = d.trim();
  return !x.includes(".") && /[^\x00-\x7F]/.test(x); // has non-ASCII and no dot
}

async function main() {
  const all = RAW.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const nonDomains = Array.from(new Set(all.filter(looksLikeName)));
  const checkable = Array.from(new Set(all.filter((d) => !isPublicOrBlank(d))));
  const skipped = all.filter((d) => isPublicOrBlank(d)).length;

  console.log(`Total rows: ${all.length} | unique checkable domains: ${checkable.length} | public/blank skipped: ${skipped}`);
  if (nonDomains.length) console.log(`Not a domain (fix in source): ${nonDomains.join(" , ")}`);

  const rows = checkable.map((d, i) => ({
    company_name: "",
    domain: d,
    email: `probe${i}@example.com`,
  }));
  const res = await runPreflight({ rows, refresh_overlap: false });

  const leaks = (res.rows || []).filter(
    (r: any) => r.verdict !== "pass" && r.verdict !== "no_contact",
  );

  console.log(`\n================  RESULT  ================`);
  if (leaks.length === 0) {
    console.log(`✓ CLEAN — all ${checkable.length} domains correctly PASS (no client leaked in).`);
  } else {
    console.log(`✗ ${leaks.length} domain(s) should NOT be PASS:\n`);
    for (const r of leaks) {
      const churn = r.churn_days != null ? `, churned ${r.churn_days}d` : "";
      console.log(`  ${r.input.domain}  ->  ${r.verdict.toUpperCase()}${churn}`);
      console.log(`     ${(r.executive_action || r.reason || "").toString().slice(0, 140)}`);
      if (r.cs_owner) console.log(`     CS owner: ${r.cs_owner}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("check failed:", e); process.exit(2); });
