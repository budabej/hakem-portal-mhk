// -----------------------------------------------------------------------
// MHK Paneli - istemci tarafı mantık.
// Bu dosya SADECE anon (public) Supabase anahtarını kullanır. Bu sayfaya
// giren herkes önce Supabase Auth ile giriş yapmak zorundadır; girişten
// sonra veri erişimi veritabanı tarafında RLS ile denetlenir: hesabının
// app_metadata.rol alanı 'mhk' olmayan biri hiçbir hakem satırını
// göremez/değiştiremez (bkz. sql/schema.sql, is_mhk()).
// -----------------------------------------------------------------------

const cfg = window.MHK_PANEL_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);
const goster = (id, evet) => { el(id).hidden = !evet; };

const KADEMELER = ["ADAY", "İL", "ULUSAL", "ULUSLARARASI"];

let tumHakemler = [];
let seciliHakem = null;
let tumYarismalar = [];
let seciliGorevliler = new Set();
let puanIstatistik = null;
let gorevIstatistik = null;

async function baslat() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await mhkMi();
  } else {
    ekranGoster("giris");
  }
}

function ekranGoster(ad) {
  goster("girisEkrani", ad === "giris");
  goster("panel", ad === "panel");
  goster("cikisBtn", ad === "panel");
}

async function mhkMi() {
  const { data: { user } } = await sb.auth.getUser();
  const rol = user?.app_metadata?.rol;
  if (rol !== "mhk") {
    el("girisHata").textContent = "Bu hesap MHK yetkisine sahip değil.";
    el("girisHata").hidden = false;
    await sb.auth.signOut();
    ekranGoster("giris");
    return;
  }
  ekranGoster("panel");
  await listeYukle();
  await yarismalarYukle();
}

async function listeYukle() {
  goster("listeYukleniyor", true);
  goster("hakemTablo", false);

  const { data, error } = await sb
    .from("hakemler")
    .select("*")
    .order("ad_soyad", { ascending: true });

  goster("listeYukleniyor", false);

  if (error) {
    el("listeYukleniyor").textContent = "Liste yüklenemedi: " + error.message;
    goster("listeYukleniyor", true);
    return;
  }

  tumHakemler = data || [];
  el("toplamSayi").textContent = tumHakemler.length;
  tabloCiz(tumHakemler);
  goster("hakemTablo", true);
}

function tabloCiz(liste) {
  const tbody = el("hakemTbody");
  tbody.innerHTML = "";

  for (const h of liste) {
    const tr = document.createElement("tr");
    tr.dataset.id = h.id;

    const kademeSecim = KADEMELER.map(
      (k) => `<option value="${k}" ${k === h.kademe ? "selected" : ""}>${k}</option>`
    ).join("");

    tr.innerHTML = `
      <td>${h.sicil_no}</td>
      <td><button class="btn btn-ghost btn-mini karne-btn" data-id="${h.id}" data-ad="${kacir(h.ad_soyad)}">${kacir(h.ad_soyad)}</button></td>
      <td><select class="kademe-sel">${kademeSecim}</select></td>
      <td><input class="il-input" type="text" value="${kacir(h.il || "")}" size="10"></td>
      <td><input class="kutuk-check" type="checkbox" ${h.kutuk_kaydi_var_mi ? "checked" : ""}></td>
      <td>${kacir(h.giris_email)}</td>
      <td>${kacir(h.iletisim_email || "—")}</td>
      <td>${kacir(h.telefon || "—")}</td>
      <td>${h.sifre_degistirmesi_gerekiyor
        ? '<span class="rozet-uyari">bekliyor</span>'
        : '<span class="rozet-ok">yapıldı</span>'}</td>
      <td><button class="btn btn-secondary btn-mini kaydet-btn" data-id="${h.id}">Kaydet</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function kacir(deger) {
  if (deger === null || deger === undefined) return "";
  const d = document.createElement("div");
  d.textContent = deger;
  return d.innerHTML;
}

el("hakemTbody").addEventListener("click", async (e) => {
  const karneBtn = e.target.closest(".karne-btn");
  if (karneBtn) {
    await karneGoster(karneBtn.dataset.id, karneBtn.dataset.ad);
    return;
  }

  const kaydetBtn = e.target.closest(".kaydet-btn");
  if (kaydetBtn) {
    const id = kaydetBtn.dataset.id;
    const tr = kaydetBtn.closest("tr");
    const kademe = tr.querySelector(".kademe-sel").value;
    const il = tr.querySelector(".il-input").value.trim() || null;
    const kutuk = tr.querySelector(".kutuk-check").checked;

    kaydetBtn.disabled = true;
    kaydetBtn.textContent = "Kaydediliyor…";

    const { error } = await sb.from("hakemler").update({
      kademe, il, kutuk_kaydi_var_mi: kutuk,
    }).eq("id", id);

    kaydetBtn.disabled = false;
    kaydetBtn.textContent = error ? "Hata!" : "Kaydedildi ✓";
    setTimeout(() => { kaydetBtn.textContent = "Kaydet"; }, 1800);

    const kayit = tumHakemler.find((h) => h.id === id);
    if (kayit && !error) { kayit.kademe = kademe; kayit.il = il; kayit.kutuk_kaydi_var_mi = kutuk; }
  }
});

// ---- HAKEM DETAY (karne + egitim/dil + vize/aidat) ----

async function karneGoster(hakemId, adSoyad) {
  seciliHakem = tumHakemler.find((h) => h.id === hakemId) || null;

  el("karneBaslik").textContent = `${adSoyad} — detay`;
  goster("karneKart", true);
  el("karneKart").scrollIntoView({ behavior: "smooth", block: "start" });

  el("detayEgitim").value = seciliHakem?.egitim || "";
  el("detayDil").value = seciliHakem?.yabanci_dil || "";
  el("detayKaydetDurum").textContent = "";

  el("detayIl").value = seciliHakem?.il || "";
  el("detayTcKimlik").value = seciliHakem?.tc_kimlik || "";
  el("detayTelefon").value = seciliHakem?.telefon || "";
  el("detayIletisimEmail").value = seciliHakem?.iletisim_email || "";
  el("detayAdres").value = seciliHakem?.adres || "";
  el("detayKimlikKaydetDurum").textContent = "";

  await vizeAidatYukle(hakemId);

  const { data, error } = await sb
    .from("hakem_puanlari")
    .select("*")
    .eq("hakem_id", hakemId)
    .order("yarisma_tarihi", { ascending: false });

  const tbody = el("karneTbody");
  if (error || !data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Kayıt yok.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((s) => `
    <tr>
      <td>${kacir(s.yarisma_adi)}</td>
      <td>${kacir(s.yarisma_tarihi)}</td>
      <td>${kacir(s.yarisma_yeri)}</td>
      <td>${kacir(s.kategori_adi)}</td>
      <td>${kacir(s.round)}</td>
      <td>${s.puan ?? "—"}</td>
    </tr>
  `).join("");
}

el("karneKapat").addEventListener("click", () => { goster("karneKart", false); seciliHakem = null; });

el("detayKaydetBtn").addEventListener("click", async () => {
  if (!seciliHakem) return;
  const egitim = el("detayEgitim").value.trim() || null;
  const yabanci_dil = el("detayDil").value.trim() || null;
  el("detayKaydetDurum").textContent = "Kaydediliyor…";

  const { error } = await sb.from("hakemler").update({ egitim, yabanci_dil }).eq("id", seciliHakem.id);

  el("detayKaydetDurum").textContent = error ? "Hata: " + error.message : "Kaydedildi ✓";
  if (!error) {
    seciliHakem.egitim = egitim;
    seciliHakem.yabanci_dil = yabanci_dil;
  }
  setTimeout(() => { el("detayKaydetDurum").textContent = ""; }, 2200);
});

el("detayKimlikKaydetBtn").addEventListener("click", async () => {
  if (!seciliHakem) return;
  const il = el("detayIl").value.trim() || null;
  const tc_kimlik = el("detayTcKimlik").value.trim() || null;
  const telefon = el("detayTelefon").value.trim() || null;
  const iletisim_email = el("detayIletisimEmail").value.trim() || null;
  const adres = el("detayAdres").value.trim() || null;
  el("detayKimlikKaydetDurum").textContent = "Kaydediliyor…";

  const { error } = await sb.from("hakemler").update({
    il, tc_kimlik, telefon, iletisim_email, adres,
  }).eq("id", seciliHakem.id);

  el("detayKimlikKaydetDurum").textContent = error ? "Hata: " + error.message : "Kaydedildi ✓";
  if (!error) {
    Object.assign(seciliHakem, { il, tc_kimlik, telefon, iletisim_email, adres });
    filtreliListeyiCiz();
  }
  setTimeout(() => { el("detayKimlikKaydetDurum").textContent = ""; }, 2200);
});

async function vizeAidatYukle(hakemId) {
  const [{ data: vize }, { data: aidat }] = await Promise.all([
    sb.from("hakem_vize_kayitlari").select("*").eq("hakem_id", hakemId).order("yil", { ascending: false }),
    sb.from("hakem_aidat_kayitlari").select("*").eq("hakem_id", hakemId).order("yil", { ascending: false }),
  ]);
  yilListesiCiz("vizeListesi", vize || []);
  yilListesiCiz("aidatListesi", aidat || []);
}

function yilListesiCiz(containerId, kayitlar) {
  const kapsayici = el(containerId);
  if (kayitlar.length === 0) {
    kapsayici.innerHTML = `<span class="muted">Kayıt yok.</span>`;
    return;
  }
  kapsayici.innerHTML = kayitlar.map((k) => `
    <span class="yil-chip" data-id="${k.id}">
      ${k.yil}
      <button type="button" class="yil-sil" data-id="${k.id}" data-tablo="${containerId === "vizeListesi" ? "hakem_vize_kayitlari" : "hakem_aidat_kayitlari"}" title="Kaydı sil">✕</button>
    </span>
  `).join("");
}

async function yilEkle(tablo, alan, inputEl) {
  if (!seciliHakem) return;
  const yil = parseInt(inputEl.value, 10);
  if (!yil || yil < 2000 || yil > 2100) { alert("Geçerli bir yıl girin."); return; }

  const kayit = { hakem_id: seciliHakem.id, yil, [alan]: true };
  const { error } = await sb.from(tablo).upsert(kayit, { onConflict: "hakem_id,yil" });
  if (error) { alert("Kaydedilemedi: " + error.message); return; }

  inputEl.value = "";
  await vizeAidatYukle(seciliHakem.id);
  puanIstatistik = null; gorevIstatistik = null; // istatistikler bir sonraki acilista tazelensin
}

el("vizeEkleBtn").addEventListener("click", () => yilEkle("hakem_vize_kayitlari", "katildi_mi", el("vizeYeniYil")));
el("aidatEkleBtn").addEventListener("click", () => yilEkle("hakem_aidat_kayitlari", "odendi_mi", el("aidatYeniYil")));

el("karneKart").addEventListener("click", async (e) => {
  const silBtn = e.target.closest(".yil-sil");
  if (silBtn && seciliHakem) {
    const { error } = await sb.from(silBtn.dataset.tablo).delete().eq("id", silBtn.dataset.id);
    if (!error) await vizeAidatYukle(seciliHakem.id);
  }
});

// ---- YARIŞMA VE GÖREVLENDİRME ----

async function yarismalarYukle() {
  const { data } = await sb.from("yarismalar").select("*").order("tarih", { ascending: false });
  tumYarismalar = data || [];
  const sel = el("yarismaSecici");
  sel.innerHTML = `<option value="">— seçin —</option>` + tumYarismalar.map((y) =>
    `<option value="${y.id}">${kacir(y.ad)}${y.tarih ? " (" + y.tarih + ")" : ""}</option>`
  ).join("");
}

el("yarismaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ad = el("yarismaAd").value.trim();
  const tarih = el("yarismaTarih").value || null;
  const yer = el("yarismaYer").value.trim() || null;
  if (!ad) return;

  const { data, error } = await sb.from("yarismalar").insert({ ad, tarih, yer }).select().single();
  if (error) { alert("Oluşturulamadı: " + error.message); return; }

  el("yarismaForm").reset();
  await yarismalarYukle();
  el("yarismaSecici").value = data.id;
  await gorevPaneliYukle(data.id);
});

el("yarismaSecici").addEventListener("change", async (e) => {
  const id = e.target.value;
  if (!id) { goster("gorevTablo", false); goster("gorevKaydetBtn", false); return; }
  await gorevPaneliYukle(id);
});

async function istatistikleriHazirla() {
  if (puanIstatistik && gorevIstatistik) return;
  const buYilNo = new Date().getFullYear();

  const { data: puanlar } = await sb.from("hakem_puanlari").select("hakem_id, yarisma_adi, yarisma_tarihi");
  puanIstatistik = new Map();
  const gorulenler = new Set();
  for (const p of (puanlar || [])) {
    if (!p.yarisma_tarihi) continue;
    const anahtar = p.hakem_id + "|" + p.yarisma_adi + "|" + p.yarisma_tarihi;
    if (gorulenler.has(anahtar)) continue;
    gorulenler.add(anahtar);
    const kayit = puanIstatistik.get(p.hakem_id) || { buYil: 0, sonTarih: null };
    const yil = parseInt(String(p.yarisma_tarihi).slice(0, 4), 10);
    if (yil === buYilNo) kayit.buYil += 1;
    if (!kayit.sonTarih || p.yarisma_tarihi > kayit.sonTarih) kayit.sonTarih = p.yarisma_tarihi;
    puanIstatistik.set(p.hakem_id, kayit);
  }

  const { data: gorevler } = await sb.from("gorevlendirmeler").select("hakem_id, yarismalar(tarih)");
  gorevIstatistik = new Map();
  for (const g of (gorevler || [])) {
    const tarih = g.yarismalar?.tarih;
    if (!tarih) continue;
    const kayit = gorevIstatistik.get(g.hakem_id) || { buYil: 0, sonTarih: null };
    const yil = parseInt(String(tarih).slice(0, 4), 10);
    if (yil === buYilNo) kayit.buYil += 1;
    if (!kayit.sonTarih || tarih > kayit.sonTarih) kayit.sonTarih = tarih;
    gorevIstatistik.set(g.hakem_id, kayit);
  }
}

function hakemIstatistik(hakemId) {
  const a = puanIstatistik?.get(hakemId) || { buYil: 0, sonTarih: null };
  const b = gorevIstatistik?.get(hakemId) || { buYil: 0, sonTarih: null };
  let sonTarih = a.sonTarih;
  if (b.sonTarih && (!sonTarih || b.sonTarih > sonTarih)) sonTarih = b.sonTarih;
  return { buYil: a.buYil + b.buYil, sonTarih };
}

async function gorevPaneliYukle(yarismaId) {
  goster("gorevYukleniyor", true);
  goster("gorevTablo", false);
  goster("gorevKaydetBtn", false);

  await istatistikleriHazirla();

  const { data: mevcut } = await sb.from("gorevlendirmeler").select("hakem_id").eq("yarisma_id", yarismaId);
  seciliGorevliler = new Set((mevcut || []).map((g) => g.hakem_id));

  const tbody = el("gorevTbody");
  tbody.innerHTML = tumHakemler.map((h) => {
    const ist = hakemIstatistik(h.id);
    const checked = seciliGorevliler.has(h.id) ? "checked" : "";
    return `
      <tr>
        <td><input type="checkbox" class="gorev-check" data-id="${h.id}" ${checked}></td>
        <td>${h.sicil_no}</td>
        <td>${kacir(h.ad_soyad)}</td>
        <td>${kacir(h.kademe)}</td>
        <td>${ist.buYil}</td>
        <td>${ist.sonTarih || "—"}</td>
      </tr>
    `;
  }).join("");

  goster("gorevYukleniyor", false);
  goster("gorevTablo", true);
  goster("gorevKaydetBtn", true);
  el("gorevKaydetBtn").dataset.yarismaId = yarismaId;
}

el("gorevKaydetBtn").addEventListener("click", async () => {
  const yarismaId = el("gorevKaydetBtn").dataset.yarismaId;
  const btn = el("gorevKaydetBtn");
  btn.disabled = true;
  el("gorevKaydetDurum").textContent = "Kaydediliyor…";

  const yeniSecili = new Set();
  document.querySelectorAll(".gorev-check").forEach((c) => { if (c.checked) yeniSecili.add(c.dataset.id); });

  const eklenecekler = [...yeniSecili].filter((id) => !seciliGorevliler.has(id));
  const silinecekler = [...seciliGorevliler].filter((id) => !yeniSecili.has(id));

  let hata = null;
  if (eklenecekler.length > 0) {
    const { error } = await sb.from("gorevlendirmeler").insert(
      eklenecekler.map((hakem_id) => ({ yarisma_id: yarismaId, hakem_id }))
    );
    if (error) hata = error;
  }
  if (!hata && silinecekler.length > 0) {
    const { error } = await sb.from("gorevlendirmeler")
      .delete()
      .eq("yarisma_id", yarismaId)
      .in("hakem_id", silinecekler);
    if (error) hata = error;
  }

  btn.disabled = false;
  el("gorevKaydetDurum").textContent = hata ? "Hata: " + hata.message : "Kaydedildi ✓";
  if (!hata) {
    seciliGorevliler = yeniSecili;
    puanIstatistik = null; gorevIstatistik = null;
  }
  setTimeout(() => { el("gorevKaydetDurum").textContent = ""; }, 2500);
});

// ---- ARAMA / GİRİŞ / ÇIKIŞ ----

function filtreliListeyiCiz() {
  const q = el("arama").value.trim().toLocaleUpperCase("tr-TR");
  const filtreli = q
    ? tumHakemler.filter((h) => h.ad_soyad.toLocaleUpperCase("tr-TR").includes(q))
    : tumHakemler;
  tabloCiz(filtreli);
}

el("arama").addEventListener("input", filtreliListeyiCiz);

el("girisForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("girisHata").hidden = true;
  const email = el("girisEmail").value.trim();
  const sifre = el("girisSifre").value;

  const { error } = await sb.auth.signInWithPassword({ email, password: sifre });
  if (error) {
    el("girisHata").textContent = "Giriş başarısız: e-posta ya da şifre hatalı.";
    el("girisHata").hidden = false;
    return;
  }
  await mhkMi();
});

el("cikisBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  el("girisForm").reset();
  ekranGoster("giris");
});

baslat();
