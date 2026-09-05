// -----------------------------------------------------------------------
// MHK Paneli - istemci tarafı mantık.
// Bu dosya SADECE anon (public) Supabase anahtarını kullanır. Bu sayfaya
// giren herkes önce Supabase Auth ile giriş yapmak zorundadır; girişten
// sonra veri erişimi veritabanı tarafında RLS ile denetlenir: hesabının
// app_metadata.rol alanı 'mhk' olmayan biri hiçbir hakem satırını
// göremez/değiştiremez (bkz. sql/schema.sql, is_mhk()). Kademe ve il
// değişiklikleri ayrıca 3 farklı MHK üyesinin onayını gerektirir (bkz.
// talebi_uygula() ve hakemler_protect_fields() - sql/schema.sql v4).
// -----------------------------------------------------------------------

const cfg = window.MHK_PANEL_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);
const goster = (id, evet) => { el(id).hidden = !evet; };

const KADEMELER = ["ADAY", "İL", "ULUSAL", "ULUSLARARASI"];
const SEKMELER = ["liste", "aday", "terfi", "yarisma", "onay", "istatistik", "aktarim"];

let tumHakemler = [];
let seciliHakem = null;
let tumYarismalar = [];
let seciliGorevliler = new Set();
let puanIstatistik = null;
let gorevIstatistik = null;
let yillikIstatistikCache = null;

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
  await onaySayisiniGetir();
  sekmeGoster("liste");
}

// ---- SEKME (TAB) YÖNETİMİ ----

function sekmeGoster(ad) {
  for (const s of SEKMELER) {
    const kutu = document.querySelector(`[data-sekme-icerik="${s}"]`);
    if (kutu) kutu.hidden = (s !== ad);
  }
  document.querySelectorAll(".sekme-btn").forEach((b) => b.classList.toggle("aktif", b.dataset.sekme === ad));

  if (ad === "aday") adayTablosuCiz();
  if (ad === "terfi") terfiTablosuCiz();
  if (ad === "onay") bekleyenOnaylariYukle();
  if (ad === "istatistik") istatistikSayfasiYukle();
}

document.querySelectorAll(".sekme-btn").forEach((b) => {
  b.addEventListener("click", () => sekmeGoster(b.dataset.sekme));
});

function bugununTarihi() {
  return new Date().toISOString().slice(0, 10);
}

// ---- HAKEM LİSTESİ ----

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

function filtreliListeyiCiz() {
  const q = el("arama").value.trim().toLocaleUpperCase("tr-TR");
  const filtreli = q
    ? tumHakemler.filter((h) => h.ad_soyad.toLocaleUpperCase("tr-TR").includes(q))
    : tumHakemler;
  tabloCiz(filtreli);
}

el("arama").addEventListener("input", filtreliListeyiCiz);

// ---- KADEME / İL: DOĞRUDAN YAZ YA DA ONAY TALEBİ OLUŞTUR ----
//
// Kademe her zaman, il ise (daha önce boş değilse) veritabanı tetikleyicisi
// tarafından doğrudan güncellemeye kapatıldı. Önce normal update denenir;
// tetikleyici onay gerektiren bir hata döndürürse otomatik olarak bir
// degisiklik_talepleri kaydı + kendi onayımız eklenir ve talebi_uygula()
// çağrılır (3. onaya kadar bir şey değişmez).
async function alanGuncelleVeyaTalepOlustur(hakemId, alan, yeniDeger, yeniTarih) {
  const { error } = await sb.from("hakemler").update({ [alan]: yeniDeger }).eq("id", hakemId);
  if (!error) return { basarili: true, dogrudan: true };

  if (!/onay[ıi] gerektirir/i.test(error.message || "")) {
    return { basarili: false, hata: error.message };
  }

  const { data: { user } } = await sb.auth.getUser();
  const hakem = tumHakemler.find((h) => h.id === hakemId);
  const { data: talep, error: talepHata } = await sb.from("degisiklik_talepleri").insert({
    hakem_id: hakemId,
    alan,
    eski_deger: hakem ? (hakem[alan] ?? null) : null,
    yeni_deger: String(yeniDeger),
    yeni_tarih: yeniTarih || null,
    talep_eden: user.id,
  }).select().single();
  if (talepHata) return { basarili: false, hata: talepHata.message };

  const { error: onayHata } = await sb.from("degisiklik_onaylari").insert({ talep_id: talep.id, onaylayan: user.id });
  if (onayHata) return { basarili: false, hata: onayHata.message };

  await sb.rpc("talebi_uygula", { p_talep_id: talep.id });
  return { basarili: true, dogrudan: false, talepId: talep.id };
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
    const kademeYeni = tr.querySelector(".kademe-sel").value;
    const ilYeni = tr.querySelector(".il-input").value.trim() || null;
    const kutuk = tr.querySelector(".kutuk-check").checked;
    const kayit = tumHakemler.find((h) => h.id === id);

    kaydetBtn.disabled = true;
    kaydetBtn.textContent = "Kaydediliyor…";

    const mesajlar = [];

    const { error: kutukHata } = await sb.from("hakemler").update({ kutuk_kaydi_var_mi: kutuk }).eq("id", id);
    if (kutukHata) mesajlar.push("Kütük kaydı: " + kutukHata.message);
    else if (kayit) kayit.kutuk_kaydi_var_mi = kutuk;

    if (kayit && kademeYeni !== kayit.kademe) {
      const sonuc = await alanGuncelleVeyaTalepOlustur(id, "kademe", kademeYeni, bugununTarihi());
      if (!sonuc.basarili) mesajlar.push("Kademe: " + sonuc.hata);
      else if (sonuc.dogrudan) { kayit.kademe = kademeYeni; mesajlar.push("Kademe güncellendi."); }
      else { mesajlar.push("Kademe için onay talebi oluşturuldu (1/3)."); await onaySayisiniGetir(); }
    }

    if (kayit && ilYeni !== (kayit.il || null)) {
      const sonuc = await alanGuncelleVeyaTalepOlustur(id, "il", ilYeni, null);
      if (!sonuc.basarili) mesajlar.push("İl: " + sonuc.hata);
      else if (sonuc.dogrudan) { kayit.il = ilYeni; mesajlar.push("İl güncellendi."); }
      else { mesajlar.push("İl için onay talebi oluşturuldu (1/3)."); await onaySayisiniGetir(); }
    }

    kaydetBtn.disabled = false;
    kaydetBtn.textContent = "Kaydet";
    if (mesajlar.length) alert(mesajlar.join("\n"));
    filtreliListeyiCiz();
  }
});

// ---- ADAY HAKEMLER / TERFİ YÖNETİMİ ----

function terfiSatiriUret(h) {
  const kademeSecim = KADEMELER.map((k) => `<option value="${k}" ${k === h.kademe ? "selected" : ""}>${k}</option>`).join("");
  return `
    <tr data-id="${h.id}">
      <td>${h.sicil_no}</td>
      <td>${kacir(h.ad_soyad)}</td>
      <td>${kacir(h.il || "—")}</td>
      <td><select class="terfi-kademe-sel">${kademeSecim}</select></td>
      <td><input type="date" class="terfi-tarih-input" value="${bugununTarihi()}"></td>
      <td><button type="button" class="btn btn-secondary btn-mini terfi-talep-btn" data-id="${h.id}">Talep oluştur</button></td>
    </tr>
  `;
}

function adayTablosuCiz() {
  const adaylar = tumHakemler.filter((h) => h.kademe === "ADAY");
  el("adayTbody").innerHTML = adaylar.length
    ? adaylar.map(terfiSatiriUret).join("")
    : `<tr><td colspan="6" class="muted">Aday hakem yok.</td></tr>`;
}

function terfiTablosuCiz() {
  el("terfiTbody").innerHTML = tumHakemler.length
    ? tumHakemler.map(terfiSatiriUret).join("")
    : `<tr><td colspan="6" class="muted">Kayıt yok.</td></tr>`;
}

async function terfiTalepOlustur(hakemId, tr) {
  const yeniKademe = tr.querySelector(".terfi-kademe-sel").value;
  const tarih = tr.querySelector(".terfi-tarih-input").value || null;
  const hakem = tumHakemler.find((h) => h.id === hakemId);
  if (!hakem) return;
  if (yeniKademe === hakem.kademe) { alert("Kademe zaten bu değerde."); return; }

  const btn = tr.querySelector(".terfi-talep-btn");
  btn.disabled = true;
  btn.textContent = "Gönderiliyor…";
  const sonuc = await alanGuncelleVeyaTalepOlustur(hakemId, "kademe", yeniKademe, tarih);
  btn.disabled = false;
  btn.textContent = "Talep oluştur";

  if (!sonuc.basarili) { alert("Hata: " + sonuc.hata); return; }
  if (sonuc.dogrudan) {
    hakem.kademe = yeniKademe;
    alert("Kademe güncellendi.");
  } else {
    alert("Terfi talebi oluşturuldu (1/3 onay). \"Bekleyen Onaylar\" sayfasından takip edebilirsiniz.");
  }
  await onaySayisiniGetir();
  adayTablosuCiz();
  terfiTablosuCiz();
  filtreliListeyiCiz();
}

el("adayTbody").addEventListener("click", (e) => {
  const btn = e.target.closest(".terfi-talep-btn");
  if (btn) terfiTalepOlustur(btn.dataset.id, btn.closest("tr"));
});
el("terfiTbody").addEventListener("click", (e) => {
  const btn = e.target.closest(".terfi-talep-btn");
  if (btn) terfiTalepOlustur(btn.dataset.id, btn.closest("tr"));
});

// ---- BEKLEYEN ONAYLAR ----

async function onaySayisiniGetir() {
  const { count } = await sb
    .from("degisiklik_talepleri")
    .select("id", { count: "exact", head: true })
    .eq("durum", "bekliyor");
  onayRozetiGuncelle(count || 0);
}

function onayRozetiGuncelle(sayi) {
  const rozet = el("onaySayisiRozet");
  rozet.textContent = sayi;
  rozet.hidden = sayi === 0;
}

async function bekleyenOnaylariYukle() {
  goster("onayYukleniyor", true);
  el("onayListesi").innerHTML = "";

  const { data: talepler, error } = await sb
    .from("degisiklik_talepleri")
    .select("*, hakemler(ad_soyad, sicil_no)")
    .eq("durum", "bekliyor")
    .order("created_at", { ascending: true });

  goster("onayYukleniyor", false);
  if (error) {
    el("onayListesi").innerHTML = `<p class="hata">Yüklenemedi: ${kacir(error.message)}</p>`;
    return;
  }

  if (!talepler || talepler.length === 0) {
    el("onayListesi").innerHTML = `<p class="muted">Bekleyen talep yok.</p>`;
    onayRozetiGuncelle(0);
    return;
  }

  const { data: { user } } = await sb.auth.getUser();
  const talepIdler = talepler.map((t) => t.id);
  const { data: onaylar } = await sb.from("degisiklik_onaylari").select("talep_id, onaylayan").in("talep_id", talepIdler);

  el("onayListesi").innerHTML = talepler.map((t) => {
    const buTalepOnaylari = (onaylar || []).filter((o) => o.talep_id === t.id);
    const benOnayladimMi = buTalepOnaylari.some((o) => o.onaylayan === user.id);
    const sayi = buTalepOnaylari.length;
    const alanEtiket = t.alan === "kademe" ? "Kademe" : "İl";
    return `
      <div class="onay-karti">
        <div>
          <strong>${kacir(t.hakemler?.ad_soyad || "?")}</strong> (sicil ${t.hakemler?.sicil_no ?? "?"})
          — ${alanEtiket}: <span class="eski-deger">${kacir(t.eski_deger || "—")}</span> → <span class="yeni-deger">${kacir(t.yeni_deger)}</span>
          ${t.yeni_tarih ? ` (tarih: ${kacir(t.yeni_tarih)})` : ""}
          <div class="muted">${sayi}/3 onay</div>
        </div>
        <div class="onay-aksiyon">
          ${benOnayladimMi
            ? `<span class="rozet-ok">Onayınız kaydedildi ✓</span>`
            : `<button type="button" class="btn btn-primary btn-mini onayla-btn" data-id="${t.id}">Onayla</button>`}
          <button type="button" class="btn btn-ghost btn-mini reddet-btn" data-id="${t.id}">Reddet</button>
        </div>
      </div>
    `;
  }).join("");

  onayRozetiGuncelle(talepler.length);
}

el("onayListesi").addEventListener("click", async (e) => {
  const onaylaBtn = e.target.closest(".onayla-btn");
  const reddetBtn = e.target.closest(".reddet-btn");

  if (onaylaBtn) {
    onaylaBtn.disabled = true;
    const { data: { user } } = await sb.auth.getUser();
    const { error } = await sb.from("degisiklik_onaylari").insert({ talep_id: onaylaBtn.dataset.id, onaylayan: user.id });
    if (error) { alert("Onaylanamadı: " + error.message); onaylaBtn.disabled = false; return; }
    await sb.rpc("talebi_uygula", { p_talep_id: onaylaBtn.dataset.id });
    await listeYukle();
    await bekleyenOnaylariYukle();
  }

  if (reddetBtn) {
    if (!confirm("Bu talebi reddetmek istediğinize emin misiniz?")) return;
    const { error } = await sb.from("degisiklik_talepleri")
      .update({ durum: "reddedildi", karar_tarihi: new Date().toISOString() })
      .eq("id", reddetBtn.dataset.id);
    if (!error) await bekleyenOnaylariYukle();
  }
});

// ---- HAKEM DETAY (karne + kimlik/iletişim + egitim/dil + vize/aidat) ----

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
    tc_kimlik, telefon, iletisim_email, adres,
  }).eq("id", seciliHakem.id);

  let ilMesaj = "";
  if (il !== (seciliHakem.il || null)) {
    const sonuc = await alanGuncelleVeyaTalepOlustur(seciliHakem.id, "il", il, null);
    if (!sonuc.basarili) ilMesaj = " (İl hatası: " + sonuc.hata + ")";
    else if (sonuc.dogrudan) { seciliHakem.il = il; ilMesaj = " (İl güncellendi)"; }
    else { ilMesaj = " (İl için onay talebi oluşturuldu, 1/3)"; await onaySayisiniGetir(); }
  }

  el("detayKimlikKaydetDurum").textContent = (error ? "Hata: " + error.message : "Kaydedildi ✓") + ilMesaj;
  if (!error) {
    Object.assign(seciliHakem, { tc_kimlik, telefon, iletisim_email, adres });
    filtreliListeyiCiz();
  }
  setTimeout(() => { el("detayKimlikKaydetDurum").textContent = ""; }, 3500);
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
  puanIstatistik = null; gorevIstatistik = null;
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

// ---- İSTATİSTİKLER (yıllara göre görev ve puan) ----

function yillikIstatistikleriHesapla(puanlar) {
  const perHakemYil = new Map();
  for (const p of puanlar) {
    if (!p.yarisma_tarihi) continue;
    const yil = parseInt(String(p.yarisma_tarihi).slice(0, 4), 10);
    if (!yil) continue;
    const key = p.hakem_id + "|" + yil;
    if (!perHakemYil.has(key)) {
      perHakemYil.set(key, {
        hakemId: p.hakem_id,
        adSoyad: p.hakemler?.ad_soyad || "?",
        sicilNo: p.hakemler?.sicil_no ?? "?",
        yil, toplamPuan: 0, puanAdet: 0, gorevSet: new Set(),
      });
    }
    const kayit = perHakemYil.get(key);
    if (p.puan !== null && p.puan !== undefined) {
      kayit.toplamPuan += Number(p.puan);
      kayit.puanAdet += 1;
    }
    kayit.gorevSet.add(p.yarisma_adi + "|" + p.yarisma_tarihi);
  }
  return Array.from(perHakemYil.values()).map((k) => ({
    ...k,
    ortalamaPuan: k.puanAdet ? k.toplamPuan / k.puanAdet : null,
    gorevSayisi: k.gorevSet.size,
  }));
}

async function istatistikSayfasiYukle() {
  goster("istatistikYukleniyor", true);
  goster("istatistikTablo", false);

  if (!yillikIstatistikCache) {
    const { data, error } = await sb
      .from("hakem_puanlari")
      .select("hakem_id, yarisma_adi, yarisma_tarihi, puan, hakemler(ad_soyad, sicil_no)");
    if (error) {
      el("istatistikYukleniyor").textContent = "Yüklenemedi: " + error.message;
      goster("istatistikYukleniyor", true);
      return;
    }
    yillikIstatistikCache = yillikIstatistikleriHesapla(data || []);
  }

  const yillar = [...new Set(yillikIstatistikCache.map((k) => k.yil))].sort((a, b) => b - a);
  const secim = el("istatistikYil");
  if (!secim.dataset.dolduruldu) {
    secim.innerHTML = yillar.map((y) => `<option value="${y}">${y}</option>`).join("");
    secim.dataset.dolduruldu = "1";
  }

  const yil = secim.value ? parseInt(secim.value, 10) : yillar[0];
  istatistikTablosunuCiz(yil);
  goster("istatistikYukleniyor", false);
  goster("istatistikTablo", true);
}

function istatistikTablosunuCiz(yil) {
  const satirlar = yillikIstatistikCache
    .filter((k) => k.yil === yil)
    .sort((a, b) => (b.ortalamaPuan ?? -1) - (a.ortalamaPuan ?? -1));

  el("istatistikTbody").innerHTML = satirlar.length
    ? satirlar.map((k) => `
      <tr>
        <td>${k.sicilNo}</td>
        <td>${kacir(k.adSoyad)}</td>
        <td>${k.gorevSayisi}</td>
        <td>${k.ortalamaPuan !== null ? k.ortalamaPuan.toFixed(2) : "—"}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted">Bu yıl için kayıt yok.</td></tr>`;
}

el("istatistikYil").addEventListener("change", (e) => {
  istatistikTablosunuCiz(parseInt(e.target.value, 10));
});

// ---- TOPLU İÇE/DIŞA AKTARIM (Excel) ----

function dosyadanSatirlarOku(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws, { defval: null }));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("Dosya okunamadı."));
    reader.readAsArrayBuffer(file);
  });
}

function satirlariIndir(rows, dosyaAdi) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Veri");
  XLSX.writeFile(wb, dosyaAdi);
}

const HAKEM_AKTARIM_ALANLARI = ["il", "telefon", "iletisim_email", "adres", "tc_kimlik", "egitim", "yabanci_dil", "kutuk_kaydi_var_mi"];

el("hakemSablonBtn").addEventListener("click", () => {
  const ornekSicil = tumHakemler[0]?.sicil_no || 1000;
  satirlariIndir([{
    sicil_no: ornekSicil, il: "İZMİR", telefon: "05xxxxxxxxx", iletisim_email: "ornek@eposta.com",
    adres: "Örnek adres", tc_kimlik: "12345678901", egitim: "Lisans", yabanci_dil: "İngilizce", kutuk_kaydi_var_mi: "EVET",
  }], "hakem_bilgileri_sablon.xlsx");
});

el("hakemDisaAktarBtn").addEventListener("click", () => {
  const satirlar = tumHakemler.map((h) => ({
    sicil_no: h.sicil_no, ad_soyad: h.ad_soyad, kademe: h.kademe, il: h.il, telefon: h.telefon,
    iletisim_email: h.iletisim_email, adres: h.adres, tc_kimlik: h.tc_kimlik, egitim: h.egitim,
    yabanci_dil: h.yabanci_dil, kutuk_kaydi_var_mi: h.kutuk_kaydi_var_mi ? "EVET" : "HAYIR",
    tarih_aday: h.tarih_aday, tarih_il: h.tarih_il, tarih_ulusal: h.tarih_ulusal, tarih_uluslararasi: h.tarih_uluslararasi,
  }));
  satirlariIndir(satirlar, "hakem_bilgileri.xlsx");
});

el("hakemIceAktarBtn").addEventListener("click", async () => {
  const dosya = el("hakemIceAktarDosya").files[0];
  if (!dosya) { alert("Önce bir dosya seçin."); return; }
  const durum = el("hakemAktarimDurum");
  durum.textContent = "Okunuyor…";

  let satirlar;
  try { satirlar = await dosyadanSatirlarOku(dosya); }
  catch (err) { durum.textContent = "Dosya okunamadı: " + err.message; return; }

  durum.textContent = "İşleniyor…";
  let guncellenen = 0, talepOlusan = 0, eslesmeyen = 0, hatali = 0;
  const hataMesajlari = [];

  for (const satir of satirlar) {
    const sicilNo = parseInt(satir.sicil_no, 10);
    const hakem = tumHakemler.find((h) => h.sicil_no === sicilNo);
    if (!hakem) { eslesmeyen++; continue; }

    const guncelleme = {};
    for (const alan of HAKEM_AKTARIM_ALANLARI) {
      if (satir[alan] === undefined || satir[alan] === null || satir[alan] === "") continue;
      if (alan === "kutuk_kaydi_var_mi") {
        guncelleme[alan] = /^(evet|true|1|var)$/i.test(String(satir[alan]).trim());
      } else {
        guncelleme[alan] = String(satir[alan]).trim();
      }
    }
    if (Object.keys(guncelleme).length === 0) continue;

    let ilDegeri = null;
    if ("il" in guncelleme) { ilDegeri = guncelleme.il; delete guncelleme.il; }

    if (Object.keys(guncelleme).length > 0) {
      const { error } = await sb.from("hakemler").update(guncelleme).eq("id", hakem.id);
      if (error) { hatali++; hataMesajlari.push(`Sicil ${sicilNo}: ${error.message}`); continue; }
      Object.assign(hakem, guncelleme);
      guncellenen++;
    }

    if (ilDegeri !== null && ilDegeri !== (hakem.il || null)) {
      const sonuc = await alanGuncelleVeyaTalepOlustur(hakem.id, "il", ilDegeri, null);
      if (!sonuc.basarili) { hatali++; hataMesajlari.push(`Sicil ${sicilNo} (il): ${sonuc.hata}`); }
      else if (sonuc.dogrudan) { hakem.il = ilDegeri; guncellenen++; }
      else talepOlusan++;
    }
  }

  if (talepOlusan > 0) await onaySayisiniGetir();

  durum.innerHTML = `
    ${guncellenen} hakem güncellendi, ${talepOlusan} il değişikliği için onay talebi oluşturuldu,
    ${eslesmeyen} sicil no eşleşmedi, ${hatali} hata.
    ${hataMesajlari.length ? "<br>" + hataMesajlari.slice(0, 10).map(kacir).join("<br>") : ""}
  `;
  el("hakemIceAktarDosya").value = "";
  filtreliListeyiCiz();
});

el("puanSablonBtn").addEventListener("click", () => {
  const ornekSicil = tumHakemler[0]?.sicil_no || 1000;
  satirlariIndir([{
    sicil_no: ornekSicil, yarisma_adi: "Örnek Yarışma 2025", yarisma_tarihi: "2025-05-10",
    yarisma_yeri: "Ankara", kategori_adi: "Erkekler 75kg", round: "Final", puan: 85.5, kategori_qty: 8,
  }], "puan_sablon.xlsx");
});

el("puanDisaAktarBtn").addEventListener("click", async () => {
  const durum = el("puanAktarimDurum");
  durum.textContent = "Hazırlanıyor…";
  const { data, error } = await sb
    .from("hakem_puanlari")
    .select("*, hakemler(sicil_no, ad_soyad)")
    .order("yarisma_tarihi", { ascending: false });
  if (error) { durum.textContent = "Hata: " + error.message; return; }

  const satirlar = (data || []).map((p) => ({
    sicil_no: p.hakemler?.sicil_no, ad_soyad: p.hakemler?.ad_soyad, yarisma_adi: p.yarisma_adi,
    yarisma_tarihi: p.yarisma_tarihi, yarisma_yeri: p.yarisma_yeri, kategori_adi: p.kategori_adi,
    round: p.round, puan: p.puan, kategori_qty: p.kategori_qty,
  }));
  satirlariIndir(satirlar, "yarisma_puanlari.xlsx");
  durum.textContent = `${satirlar.length} kayıt indirildi.`;
});

el("puanIceAktarBtn").addEventListener("click", async () => {
  const dosya = el("puanIceAktarDosya").files[0];
  if (!dosya) { alert("Önce bir dosya seçin."); return; }
  const durum = el("puanAktarimDurum");
  durum.textContent = "Okunuyor…";

  let satirlar;
  try { satirlar = await dosyadanSatirlarOku(dosya); }
  catch (err) { durum.textContent = "Dosya okunamadı: " + err.message; return; }

  durum.textContent = "Mevcut kayıtlarla karşılaştırılıyor…";
  const { data: mevcutlar, error: mevcutHata } = await sb
    .from("hakem_puanlari")
    .select("hakem_id, yarisma_adi, yarisma_tarihi, kategori_adi, round, puan");
  if (mevcutHata) { durum.textContent = "Hata: " + mevcutHata.message; return; }

  const mevcutAnahtarlar = new Set((mevcutlar || []).map((m) =>
    [m.hakem_id, m.yarisma_adi, m.yarisma_tarihi, m.kategori_adi, m.round, m.puan].join("|")
  ));

  const eklenecekler = [];
  let eslesmeyen = 0, atlanan = 0;
  for (const satir of satirlar) {
    const sicilNo = parseInt(satir.sicil_no, 10);
    const hakem = tumHakemler.find((h) => h.sicil_no === sicilNo);
    if (!hakem) { eslesmeyen++; continue; }

    let tarih = satir.yarisma_tarihi;
    if (tarih instanceof Date) tarih = tarih.toISOString().slice(0, 10);
    else if (tarih) tarih = String(tarih).trim();

    const puanDegeri = (satir.puan !== null && satir.puan !== undefined && satir.puan !== "")
      ? Number(satir.puan) : null;

    const kayit = {
      hakem_id: hakem.id,
      yarisma_adi: satir.yarisma_adi ? String(satir.yarisma_adi).trim() : null,
      yarisma_tarihi: tarih || null,
      yarisma_yeri: satir.yarisma_yeri ? String(satir.yarisma_yeri).trim() : null,
      kategori_adi: satir.kategori_adi ? String(satir.kategori_adi).trim() : null,
      round: satir.round ? String(satir.round).trim() : null,
      puan: puanDegeri,
      kategori_qty: (satir.kategori_qty !== null && satir.kategori_qty !== undefined && satir.kategori_qty !== "")
        ? parseInt(satir.kategori_qty, 10) : null,
    };
    const anahtar = [kayit.hakem_id, kayit.yarisma_adi, kayit.yarisma_tarihi, kayit.kategori_adi, kayit.round, kayit.puan].join("|");
    if (mevcutAnahtarlar.has(anahtar)) { atlanan++; continue; }
    mevcutAnahtarlar.add(anahtar);
    eklenecekler.push(kayit);
  }

  let hata = null;
  for (let i = 0; i < eklenecekler.length; i += 500) {
    const { error } = await sb.from("hakem_puanlari").insert(eklenecekler.slice(i, i + 500));
    if (error) { hata = error; break; }
  }

  durum.textContent = hata
    ? `Hata: ${hata.message} (${eklenecekler.length} kayıttan bir kısmı eklenmiş olabilir)`
    : `${eklenecekler.length} yeni kayıt eklendi, ${atlanan} zaten mevcuttu (atlandı), ${eslesmeyen} sicil no eşleşmedi.`;
  el("puanIceAktarDosya").value = "";
  yillikIstatistikCache = null;
});

// ---- GİRİŞ / ÇIKIŞ ----

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
