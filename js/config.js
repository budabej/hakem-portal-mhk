// -----------------------------------------------------------------------
// MHK paneli - ayrı bir statik site/repo olarak yayınlanmalıdır (hakem
// arayüzüyle AYNI repo/domain OLMAMALIDIR).
//
// Aşağıdaki değerler Supabase'in PUBLIC/ANON anahtarıdır - tarayıcıda
// görünmesi güvenlik açığı OLUŞTURMAZ; gerçek koruma RLS ile sağlanır
// (bkz. sql/schema.sql, is_mhk() fonksiyonu).
//
// Buraya ASLA "service_role" anahtarını KOYMAYIN.
// -----------------------------------------------------------------------
window.MHK_PANEL_CONFIG = {
  SUPABASE_URL: "https://lxcbjmoqwvinhvlnfijk.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Lnhb6UdIEWXFwiIaoQBnfQ_r3KJhv8r",
};
