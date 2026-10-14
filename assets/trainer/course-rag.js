/* Курс «RAG · PG» — RAG-система в проде: PostgreSQL + pgvector.
   Все команды настоящие: psql, python, curl, jq. Формат — _HOWTO.md */

var RP_V = 'psql (16.4, server 16.4)';
var RP_DIM = 8;

/* ---------- служебное ---------- */
function rpH(s){var h=2166136261,i;for(i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*16777619)>>>0;}return h;}
function rpMs(seed,min,max){var h=rpH(seed);return (min+(h%(max-min+1))+((h>>>7)%100)/100).toFixed(3);}
function rpRep(ch,n){return new Array(Math.max(0,n)+1).join(ch);}
function rpCen(s,n){var l=Math.floor((n-s.length)/2);return rpRep(' ',l)+s+rpRep(' ',n-s.length-l);}
function rpLft(s,n){s=String(s);return s+rpRep(' ',Math.max(0,n-s.length));}
function rpRgt(s,n){s=String(s);return rpRep(' ',Math.max(0,n-s.length))+s;}

function rpTbl(head,rows,foot){
  var w=[],i,j;
  head.forEach(function(h,k){var m=String(h).length;
   for(i=0;i<rows.length;i++){var v=rows[i][k];v=(v===null||v===undefined?'':String(v));if(v.length>m)m=v.length;}
   w.push(m);});
  var out=[];
  out.push(w.map(function(n,k){return ' '+rpCen(String(head[k]),n)+' ';}).join('|'));
  out.push(w.map(function(n){return rpRep('-',n+2);}).join('+'));
  rows.forEach(function(r){out.push(w.map(function(n,k){var v=r[k];v=(v===null||v===undefined?'':String(v));return ' '+rpLft(v,n)+' ';}).join('|'));});
  if(foot)out.push(rpRgt(foot,out[0].length));
  return out.join('\n');
}

function rpPlan(lines){
  var w=lines.reduce(function(a,s){return Math.max(a,s.length);},40);
  return rpRgt('QUERY PLAN',w+6)+'\n'+rpRep('-',w+6)+'\n'+lines.join('\n');
}

function rpVecParse(s){
  var m=String(s).match(/\[([^\]]*)\]/);if(!m)return null;
  var p=m[1].split(','),v=[],i;
  if(!m[1].trim())return null;
  for(i=0;i<p.length;i++){var x=parseFloat(p[i]);if(isNaN(x))return null;v.push(x);}
  return v;
}
function rpCos(a,b){
  if(!a||!b||a.length!==b.length)return null;
  var d=0,na=0,nb=0,i;
  for(i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  if(!na||!nb)return null;
  return d/(Math.sqrt(na)*Math.sqrt(nb));
}
function rpJit(base,i){
  var h=rpH('vec'+i);
  return base.map(function(x,k){
    var d=((h>>>(k*3))%997)/997-0.5;
    return +(x+d*0.08).toFixed(4);
  });
}
function rpQVec(q){
  var s=String(q||'').toLowerCase(),best=0,vec=RP_DEFAULT_V,si,k,kw,i;
  for(si=0;si<RP_SRC.length;si++){
    var sc=0;kw=RP_KW[RP_SRC[si].s]||[];
    for(i=0;i<kw.length;i++)if(s.indexOf(kw[i])>-1)sc++;
    if(sc>best){best=sc;vec=RP_SRC[si].v;}
  }
  return vec;
}
function rpRowsWord(n){
  var a=Math.abs(n)%100,b=a%10;
  if(a>10&&a<20)return 'rows';
  if(b===1)return 'row';
  return 'rows';
}

/* ---------- корпус ---------- */
var RP_SEC_ACCESS=['Общие положения','Заявка на доступ','Согласование','Роли и права','Роль admin','Временный доступ guest','Токены и ротация','MFA','Хранилище секретов','Отзыв доступа','Увольнение','Журнал изменений','Проверка прав','Инцидент доступа'];
var RP_SEC_PASS=['Требования к длине','Сложность','Запрещённые пароли','Срок действия','Первая смена','Шифрование при хранении','Предупреждение за 7 дней','Блокировка учётной записи','Сервисные учётные записи','Удаление неактивных','Ответственность','Передача токена','Подозрительные действия'];
var RP_SEC_BAK=['Что копируем','Ежедневная копия','Время запуска 02:00','Хранилище с шифрованием','Временные файлы','Ежедневное хранение','Недельное хранение','Месячное хранение','Проверка копий','Тестовое развёртывание','Негодная копия','Откат данных','Время отката','Состав копии'];
var RP_SEC_REL=['Основная ветка main','feature-ветки','Локальные тесты','Сборка релиза','Публикация образа','Файл VERSION','Тег git','Деплой на staging','Время сборки','Откат релиза','Время отката','Проверка после деплоя','Доля ошибок','Конфигурация и секреты'];
var RP_SEC_ONC=['График смен','Длительность смены','Связь с командой','Передача смены','Первые 10 минут','Повторный алерт','Тихие алерты','Инцидент или шум','Фиксация времени','Уведомление команды','Эскалация за 30 минут','Владелец сервиса','Ночная проверка','Утренний отчёт'];
var RP_SEC_RB=['Схема docs','Тип vector(8)','Индекс hnsw','Оператор <=>','Поиск nearest','Фильтр по source','Удаление устаревших','Размерность вектора','Скорость сборки','ANALYZE','Планировщик','Fillfactor','Dead tuples','Автовакуум'];

var RP_SRC=[
 {s:'регламент_доступа.md',t:'Регламент доступа',n:30,v:[0.71,-0.22,0.15,0.33,0.58,-0.09,0.04,0.11],sec:RP_SEC_ACCESS,
  c:['Доступ к серверам, базам данных и внутренним сервисам выдаётся только по заявке.',
     'Заявка согласуется с руководителем команды и с отделом безопасности.',
     'Срок действия доступа — 90 дней с даты выдачи, продление оформляется новой заявкой.',
     'Роль задаёт набор прав: viewer, editor, admin.',
     'Роль admin выдаётся только по согласованию с руководителем эксплуатации.',
     'Временный доступ оформляется как guest с обязательным сроком действия.',
     'Для доступа используется токен с ротацией каждые 30 дней.',
     'Многофакторная аутентификация обязательна для всех ролей.',
     'Хранение токенов в открытом виде запрещено, секреты лежат в хранилище секретов.',
     'При смене команды доступ отзывается в течение 24 часов.',
     'Отзыв фиксируется в журнале изменений и проверяется ежеквартально.',
     'Просроченный доступ система блокирует автоматически.']},

 {s:'политика_паролей.md',t:'Политика паролей',n:26,v:[-0.31,0.64,0.22,-0.08,0.47,0.13,-0.52,0.09],sec:RP_SEC_PASS,
  c:['Пароль должен иметь сложность не ниже уровня 3.',
     'Минимальная длина — 14 символов, буквы разных регистров, цифры и спецсимволы.',
     'Словарные пароли и пароли из имени пользователя запрещены.',
     'Пароль меняется каждые 90 дней, первый пароль меняется при первом входе.',
     'Хранение паролей в открытом виде не допускается, используется шифрование.',
     'Предупреждение об истекающем сроке приходит за 7 дней.',
     'Учётная запись блокируется после 5 неудачных попыток входа на 15 минут.',
     'Сервисные учётные учётные записи хранятся в хранилище секретов.'.replace('учётные учётные','учётные'),
     'Учётная запись без активности удаляется через 90 дней.',
     'Каждый сотрудник отвечает за действия своей учётной записи.',
     'Передача токена доступа коллеге запрещена.',
     'О подозрительных действиях сообщают в службу безопасности.']},

 {s:'регламент_бэкапов.md',t:'Регламент бэкапов',n:32,v:[0.12,0.08,0.91,-0.17,0.23,0.66,-0.11,0.29],sec:RP_SEC_BAK,
  c:['Бэкап выполняется ежедневно для баз данных и конфигурации приложений.',
     'Полная резервная копия делается каждую ночь в 02:00 по UTC.',
     'Копия выкладывается на отдельное хранилище с шифрованием.',
     'Временные файлы в копию не попадают.',
     'Ежедневные копии хранятся 14 дней, недельные — 60 дней, месячные — 12 месяцев.',
     'Срок хранения копий с данными клиентов ограничен 90 днями.',
     'Раз в неделю копия разворачивается в тестовой среде.',
     'Если тестовое развёртывание не удалось, бэкап считается негодным и создаётся заново.',
     'Журнал проверок ведётся в трекере задач.',
     'Откат выполняется по согласованию с владельцем данных.',
     'Время отката из ночной копии — не более 40 минут.',
     'Процедура отката проверяется ежеквартально.']},

 {s:'инструкция_работы.md',t:'Инструкция по работе',n:28,v:[-0.44,0.19,0.27,0.81,-0.13,0.35,0.16,-0.24],sec:RP_SEC_REL,
  c:['Основная ветка — main, разработка ведётся в feature-ветках.',
     'Перед отправкой изменений локально выполняются тесты.',
     'Ветка не живёт дольше двух недель.',
     'Релиз готовится из main в CI: тесты, сборка образа, публикация в реестр.',
     'Версия релиза записывается в файл VERSION и в тег git.',
     'Деплой на staging выполняется автоматически после успешной сборки.',
     'Сборка релиза занимает около семи минут.',
     'Откат выполняется на предыдущий релиз и не требует ручной сборки образа.',
     'Откат занимает около трёх минут и всегда безопаснее долгой правки.',
     'Проверяем статус целей мониторинга, журнал приложения и ответы тестового запроса.',
     'Если доля ошибок выросла, откат делаем сразу и заводим инцидент.',
     'Проверка занимает первые десять минут после деплоя.']},

 {s:'инструкция_дежурного.md',t:'Инструкция дежурного',n:26,v:[0.26,-0.47,0.33,0.14,-0.62,0.09,0.41,0.18],sec:RP_SEC_ONC,
  c:['Дежурная смена длится 12 часов, дежурство распределяется по графику на месяц.',
     'На смене дежурный держит связь с командой в чате дежурок.',
     'Смена передаётся следующему дежурному вместе с отчётом.',
     'Каждый алерт разбирается в первые 10 минут.',
     'Если алерт повторился три раза — это инцидент, а не шум.',
     'Тихие алерты дежурный глушит с указанием причины.',
     'Инцидент — это недоступность сервиса или ошибки у пользователей.',
     'Дежурный фиксирует время начала, уведомляет команду и заводит инцидент.',
     'Если инцидент не закрыт за 30 минут, дежурный поднимает эскалацию.',
     'Дальше подключается владелец сервиса, эскалация фиксируется со временем.',
     'Ночью дежурный проверяет мониторинг каждые 30 минут.',
     'Утренний отчёт о смене обязателен.']},

 {s:'runbook.md',t:'Runbook · PostgreSQL',n:38,v:[0.38,0.52,-0.31,0.45,0.17,-0.44,0.28,-0.09],sec:RP_SEC_RB,dup:12,
  c:['Схема хранения чанков — таблица docs в базе app.',
     'Тип эмбеддинга объявлен как vector(8), размерность фиксирована.',
     'Индекс hnsw строится по колонке embedding с оператором vector_cosine_ops.',
     'Ближайший сосед ищется оператором <=> в поле distance.',
     'Поиск идёт запросом ORDER BY embedding <=> вектор запроса LIMIT k.',
     'Фильтр по source перед ORDER BY заставляет планировщик отказаться от индекса.',
     'Устаревшие версии документа удаляются по created_at.',
     'Размерность вектора проверяется функцией vector_dims.',
     'Большие батчи считаются дольше: следить за таймаутом HTTP.',
     'После массовой загрузки полезно выполнить ANALYZE docs.',
     'Планировщик опирается на статистику и может выбрать seq scan.',
     'Fillfactor ниже 100 оставляет место под обновления индекса.',
     'Мёртвые кортежи копятся, если vacuum не успевает за autovacuum.',
     'Автовакуум запускается по умолчанию, но порог нужно снизить.']}
];

/* ---------- сборка строк таблицы ---------- */
function rpRows(){
  var out=[],id=1,si,j;
  for(si=0;si<RP_SRC.length;si++){
    var s=RP_SRC[si];
    for(j=0;j<s.n;j++){
      var d,ts;
      if(s.dup){
        if(j<s.dup){d='2025-11-12';ts='2025-11-12 02:31:0'+(j%9)+'+00';}
        else if(j<s.dup*2){d='2025-12-28';ts='2025-12-28 03:04:1'+(j%9)+'+00';}
        else{d='2026-01-08';ts='2026-01-08 10:14:0'+(j%9)+'+00';}
      }else{
        d='2026-01-08';ts='2026-01-08 10:14:0'+(j%9)+'+00';
      }
      out.push({
        id:id,
        title:s.t+' · '+s.sec[j%s.sec.length],
        source:s.s,
        content:s.c[j%s.c.length]+' — '+s.sec[j%s.sec.length],
        chunk_idx:s.dup?(j%s.dup):j,
        d:d, ts:ts, v:rpJit(s.v,id)
      });
      id++;
    }
  }
  return out;
}

var RP_Q='[0.15, 0.11, 0.88, -0.19, 0.26, 0.61, -0.14, 0.31]';
var RP_KW={
 'регламент_доступа.md':['доступ','заявк','роль','прав','токен','отзыв','соглас','аутентиф','mfa','секрет','гост'],
 'политика_паролей.md':['парол','сложн','срок','блокир','попыт','вход','учёт','запис','шифрован'],
 'регламент_бэкапов.md':['бэкап','резерв','копил','откат','хранил','восстанов','ночн'],
 'инструкция_работы.md':['релиз','деплой','ветк','сборк','тег','верси','монитор','ошибк','откат'],
 'инструкция_дежурного.md':['дежур','алерт','инцидент','эскалац','смена','дежурк','уведом','тих'],
 'runbook.md':['hnsw','индекс','вектор','vector','pgvector','размерност','планиров','схем','оператор','<=>']
};
var RP_DEFAULT_V=[0.15,0.11,0.88,-0.19,0.26,0.61,-0.14,0.31];
var RP_SEARCH='SELECT id, title, embedding <=> \'' + RP_Q + '\' AS distance FROM docs ORDER BY embedding <=> \'' + RP_Q + '\' LIMIT 5;';

/* ---------- состояние ---------- */
var RAGP={
  docs:[],hasExt:false,hasTable:false,hasIndex:false,rows:0,dim:0,
  applied:false,queries:[],plan:'—',user:'dev',lastJson:null,

  reset:function(){
    this.docs=[];this.hasExt=false;this.hasTable=false;this.hasIndex=false;
    this.rows=0;this.dim=0;this.applied=false;this.queries=[];this.plan='—';
    this.user='dev';this.lastJson=null;
  },

  byId:function(id){for(var i=0;i<this.docs.length;i++)if(this.docs[i].id===id)return this.docs[i];return null;},
  srcOf:function(src){var o={},a=[],i;for(i=0;i<this.docs.length;i++){var k=this.docs[i].source;if(!o[k]){o[k]=0;a.push(k);}o[k]++;}return src?[src]:a;},
  cntOf:function(src){var n=0,i;for(i=0;i<this.docs.length;i++)if(!src||this.docs[i].source===src)n++;return n;},
  chunkOf:function(src){var s={},n=0,i;for(i=0;i<this.docs.length;i++){if(src&&this.docs[i].source!==src)continue;var k=this.docs[i].source+'#'+this.docs[i].chunk_idx;if(!s[k]){s[k]=1;n++;}}return n;},
  val:function(q,k){var m=String(q).match(new RegExp(k+'\\s*=\\s*\'([^\']*)\'','i'));return m?m[1]:null;},
  lim:function(q){var m=String(q).match(/limit\s+(\d+)/i);return m?Math.min(50,+m[1]):5;},
  limAll:function(q){var m=String(q).match(/limit\s+(\d+)/i);return m?Math.min(200,+m[1]):999;},

  search:function(q,qv){
    var src=this.val(q,'source'),lim=this.lim(q),out=[],i;
    for(i=0;i<this.docs.length;i++){
      var r=this.docs[i];
      if(src&&r.source!==src)continue;
      var c=rpCos(qv,r.v);if(c===null)continue;
      out.push({d:1-c,r:r});
    }
    out.sort(function(a,b){return a.d-b.d;});
    return out.slice(0,lim);
  },

  log:function(q,n,ms,top){
    this.queries.unshift({q:q,n:n,ms:ms,top:top||''});
    if(this.queries.length>6)this.queries.pop();
  },

  /* ---- psql: мета-команды ---- */
  meta:function(q){
    var t=String(q).trim();
    if(/^\\conninfo$/i.test(t))return 'You are connected to database "app" as user "'+this.user+'" on host "localhost" (address "127.0.0.1") at port "5432".\nDatabase: app\nUser: '+this.user+'\nHost: localhost\nAddress: 127.0.0.1\nPort: 5432\nSSL disabled';
    if(/^\\l$/i.test(t))return rpTbl(['Name','Owner','Encoding','Collate','Ctype','Access privileges'],[
      ['app','dev','UTF8','en_US.UTF-8','en_US.UTF-8','=Tc/dev'],
      ['postgres','postgres','UTF8','en_US.UTF-8','en_US.UTF-8','=Tc/postgres']],'(2 '+rpRowsWord(2)+')');
    if(/^\\dn/i.test(t))return rpTbl(['Name','Owner'],[['public','pg_database_owner']],'(1 row)');
    if(/^\\dt/i.test(t)){
      if(!this.hasTable)return 'Did not find any relations in schema "public".';
      return rpTbl(['Schema','Name','Type','Owner'],[['public','docs','table','dev']],'(1 row)');
    }
    if(/^\\di/i.test(t)){
      if(!this.hasIndex)return 'Did not find any relations in schema "public".';
      return rpTbl(['Schema','Name','Type','Owner','Table'],[['public','docs_embedding_hnsw','index','dev','docs']],'(1 row)');
    }
    if(/^\\dx/i.test(t)){
      var nx=(t.split(/\s+/)[1]||'vector').replace(/^["']|["']$/g,'');
      if(!this.hasExt)return 'Did not find any extension named "'+nx+'".';
      return rpTbl(['Name','Version','Schema','Description'],
        [['vector','0.7.4','public','vector data type and ivfflat and hnsw access methods']],'(1 row)');
    }
    if(/^\\d/i.test(t)){
      if(!this.hasTable)return{t:'ERROR:  relation "docs" does not exist',c:'t-err'};
      var ix=rpTbl(['Column','Type','Collation','Nullable','Default'],[
        ['id','bigint','','',"nextval('docs_id_seq'::regclass)"],
        ['title','text','','',''],
        ['source','text','','',''],
        ['content','text','','',''],
        ['chunk_idx','integer','','',''],
        ['embedding','vector(8)','','',''],
        ['created_at','timestamp with time zone','','','now()']]);
      ix+='\nIndexes:\n    "docs_pkey" PRIMARY KEY, btree (id)';
      if(this.hasIndex)ix+='\n    "docs_embedding_hnsw" INDEX, non-unique, hnsw (embedding vector_cosine_ops)';
      return ix;
    }
    if(/^\\timing/i.test(t))return 'Timing is on.';
    if(/^\\x/i.test(t))return 'Expanded display is off.';
    if(/^\\q$/i.test(t))return null;
    return {t:'\\'+t.split(/\s+/)[0]+': unrecognized command',c:'t-err'};
  },

  /* ---- psql: SQL ---- */
  sql:function(q){
    var s=this,t=String(q).trim().replace(/;\s*$/,'');
    if(!t)return null;

    if(/^CREATE\s+EXTENSION/i.test(t)){
      if(!/vector/i.test(t))return {t:'ERROR:  extension "'+(t.split(/\s+/)[3]||'x')+'" is not available\nHINT:  Could not open extension control file "/usr/share/postgresql/16/extension/'+(t.split(/\s+/)[3]||'x')+'.control": No such file or directory',c:'t-err'};
      if(this.hasExt)return {t:'ERROR:  extension "vector" already exists',c:'t-err'};
      this.hasExt=true;
      return 'CREATE EXTENSION\n\nTime: '+rpMs('ext',480,1900)+' ms';
    }
    if(/^DROP\s+EXTENSION/i.test(t)){
      if(!this.hasExt)return {t:'ERROR:  extension "vector" does not exist',c:'t-err'};
      this.hasExt=false;this.hasTable=false;this.hasIndex=false;this.applied=false;
      this.docs=[];this.rows=0;this.dim=0;this.plan='—';
      return 'DROP EXTENSION\n\nTime: '+rpMs('drext',200,900)+' ms';
    }
    if(/^CREATE\s+TABLE/i.test(t)){
      if(!/vector/i.test(t))return {t:'ERROR:  type "vector" does not exist\nHINT:  Run CREATE EXTENSION vector first.',c:'t-err'};
      if(this.hasTable)return {t:'ERROR:  relation "docs" already exists',c:'t-err'};
      this.hasTable=true;this.applied=false;this.rows=0;this.dim=RP_DIM;
      return 'CREATE TABLE\n\nTime: '+rpMs('ctbl',2,14)+' ms';
    }
    if(/^CREATE\s+INDEX/i.test(t)){
      if(!this.hasTable)return {t:'ERROR:  relation "docs" does not exist',c:'t-err'};
      if(!this.hasExt)return {t:'ERROR:  type "vector" does not exist',c:'t-err'};
      var am=(t.match(/USING\s+(\w+)/i)||[,'btree'])[1];
      if(!/hnsw|ivfflat|gist|gin/i.test(am))return {t:'ERROR:  access method "'+am+'" does not exist',c:'t-err'};
      if(this.hasIndex)return {t:'ERROR:  relation "docs_embedding_hnsw" already exists',c:'t-err'};
      this.hasIndex=true;this.applied=true;
      return 'CREATE INDEX\n\nTime: '+rpMs('cix',820,3200)+' ms';
    }
    if(/^DROP\s+INDEX/i.test(t)){
      if(!this.hasIndex)return {t:'ERROR:  index "docs_embedding_hnsw" does not exist',c:'t-err'};
      this.hasIndex=false;this.applied=false;
      return 'DROP INDEX\n\nTime: '+rpMs('dix',90,600)+' ms';
    }
    if(/^INSERT/i.test(t)){
      if(!this.hasTable)return {t:'ERROR:  relation "docs" does not exist',c:'t-err'};
      var tm=t.match(/'([^']*)'\s*,\s*(\d+)\s*,\s*'\[([^\]]*)\]'/);
      if(!tm)return {t:'ERROR:  syntax error at or near "'+(t.split(/\s+/)[1]||'')+'"',c:'t-err'};
      var vv=rpVecParse('['+tm[3]+']')||[0,0,0,0,0,0,0,0];
      this.docs.push({id:this.docs.length+1,title:tm[1],source:'ручной_ввод.md',content:tm[1],
        chunk_idx:+tm[2],d:'2026-01-09',ts:'2026-01-09 08:00:00+00',v:vv});
      this.rows=this.docs.length;
      return 'INSERT 0 1\n\nTime: '+rpMs('ins',1,9)+' ms';
    }
    if(/^DELETE/i.test(t)){
      if(!this.hasTable)return {t:'ERROR:  relation "docs" does not exist',c:'t-err'};
      var src=this.val(t,'source'),day=t.match(/'(\d{4}-\d{2}-\d{2})'/);
      var before=this.docs.length;
      this.docs=this.docs.filter(function(r){
        if(src&&r.source!==src)return true;
        if(day&&!(r.d<day[1]))return true;
        return false;
      });
      this.rows=this.docs.length;
      var was=this.applied;this.applied=false;
      var res='DELETE '+(before-this.docs.length)+'\n\nTime: '+rpMs('del',3,120)+' ms';
      if(was&&this.hasIndex)
        res+='\n\n(!) Статистики устарели: после массового DELETE планировщик временно выбирает seq scan. Помогает ANALYZE docs;';
      return res;
    }
    if(/^ANALYZE/i.test(t)){
      if(!this.hasTable)return {t:'ERROR:  relation "docs" does not exist',c:'t-err'};
      this.applied=this.hasIndex;
      return 'ANALYZE\n\nTime: '+rpMs('an',40,300)+' ms';
    }
    if(/^EXPLAIN/i.test(t))return this.explain(t);
    if(/^SELECT|^VACUUM|^UPDATE|^TRUNCATE|^BEGIN|^COMMIT/i.test(t))return this.select(t);
    if(/^SET\b/i.test(t))return 'SET';
    return {t:'ERROR:  syntax error at or near "'+t.split(/\s+/)[0]+'"',c:'t-err'};
  },

  explain:function(t){
    var q=t.replace(/^EXPLAIN\s*(\([^)]*\))?\s*/i,'').trim();
    var isVec=/<=>/.test(q),flt=/\bwhere\b/i.test(q),agg=/count\s*\(/i.test(q),src=this.val(q,'source');
    var lines,hit=this.applied&&isVec&&!flt,nr=0;
    if(agg){
      lines=['Aggregate  (cost=118.43..118.44 rows=1 width=8) (actual time=0.412..0.413 rows=1 loops=1)',
             '  ->  Seq Scan on docs  (cost=0.00..98.42 rows='+this.docs.length+' width=0) (actual time=0.009..0.287 rows='+this.docs.length+' loops=1)'];
    }else if(hit){
      lines=['Index Scan using docs_embedding_hnsw on public.docs',
             "  (order by: embedding <=> '"+RP_Q+"'::vector)",
             "  Index Cond: (embedding <=> '"+RP_Q+"'::vector)",
             '  Filter: (embedding IS NOT NULL)'];
    }else if(isVec&&flt){
      nr=this.docs.length-this.cntOf(src);
      lines=['Seq Scan on docs  (cost=0.00..1270.41, rows='+Math.max(1,Math.round(this.docs.length*0.02))+', width=96) (actual time=0.014..0.318, rows='+this.cntOf(src)+' loops=1)',
             "  Filter: (source = '"+(src||'')+"'::text)",
             '  Rows Removed by Filter: '+nr];
    }else if(isVec){
      lines=['Seq Scan on docs  (cost=0.00..1270.41, rows='+this.docs.length+', width=96) (actual time=0.014..0.402, rows='+this.docs.length+' loops=1)',
             "  Filter: (embedding <=> '"+RP_Q+"'::vector)"];
    }else{
      lines=['Seq Scan on docs  (cost=0.00..118.42, rows='+this.docs.length+', width=64) (actual time=0.009..0.221, rows='+this.docs.length+' loops=1)'];
    }
    lines.push('Planning Time: 0.0'+(rpH('pl'+q)%90)+' ms');
    lines.push('Execution Time: '+(hit?'0.412':rpMs('ex'+q.length,3,9))+' ms');
    this.plan=agg?'Seq Scan · агрегат':(hit?'Index Scan · docs_embedding_hnsw':(isVec&&flt?'Seq Scan · filter '+(src||''):'Seq Scan · full'));
    var res=rpPlan(lines)+'\n(1 row)\n\nTime: '+(hit?'0.588':rpMs('tq'+q.length,3,12))+' ms';
    if(this.applied&&isVec&&flt)
      res+='\n\n(!) docs_embedding_hnsw НЕ использован: условие по source в WHERE нельзя отдать векторному индексу, планировщик читает таблицу целиком. Уберите WHERE — и увидите Index Scan.';
    else if(hit)
      res+='\n\n(!) Index Scan — так выглядит план без фильтра по метаданным.';
    return res;
  },

  select:function(t){
    var src=this.val(t,'source'),i,q=t;
    if(/docs/.test(q)&&!this.hasTable)return {t:'ERROR:  relation "docs" does not exist',c:'t-err'};
    if(/^TRUNCATE/i.test(q))return 'TRUNCATE TABLE\n\nTime: '+rpMs('trunc',1,8)+' ms';
    if(!/\bfrom\b/i.test(q)&&!/\btable\b/i.test(q)){
      var cn=q.match(/^SELECT\s+(\d+)/i);
      if(cn)return rpTbl([cn[1]],[[cn[1]]],'(1 row)');
      if(/^SELECT\s+now\(\)/i.test(q))
        return rpTbl(['now'],[['2026-01-09 11:24:07.482913+00']],'(1 row)');
      return {t:'ERROR:  syntax error at or near "'+q.split(/\s+/)[0]+'"',c:'t-err'};
    }

    if(/<=>/.test(q)){
      if(/<=>\s*'[^']*'\s*::\s*text/i.test(q))
        return {t:'ERROR:  operator does not exist: vector <=> text\nHINT:  Приведите литерал к vector — приведение к text убивает оператор.',c:'t-err'};
      var lit=(q.match(/'\s*\[[^\]]*\]\s*'/g)||[]).pop();
      var qv=lit?rpVecParse(lit):null;
      if(!qv)return {t:'ERROR:  syntax error at or near "<=>"',c:'t-err'};
      if(qv.length!==RP_DIM)return {t:'ERROR:  expected '+RP_DIM+' dimensions, not '+qv.length,c:'t-err'};
      var hits=this.search(q,qv);
      var ms=this.applied?'0.412':rpMs('sq'+q.length,4,90);
      this.log(q,hits.length,ms,hits.length?hits[0].r.title:'');
      var res=rpTbl(['id','title','distance'],
        hits.map(function(h){return[h.r.id,h.r.title.slice(0,34),h.d.toFixed(4)];}),
        '('+hits.length+' '+rpRowsWord(hits.length)+')');
      res+='\n\nTime: '+ms+' ms';
      if(!this.applied&&hits.length)
        res+='\n\n(!) Индекс hnsw не выбран планировщиком — прочитан весь корпус ('+this.docs.length+' строк). Сделайте ANALYZE docs;';
      return res;
    }
    if(/count\s*\(\s*distinct\s+chunk_idx\s*\)/i.test(q)){
      var keys=this.srcOf(src);
      return rpTbl(['source','rows','chunks'],
        keys.map(function(k){return[k,this.cntOf(k),this.chunkOf(k)];},this),
        '('+keys.length+' '+rpRowsWord(keys.length)+')');
    }
    if(/count\s*\(\s*\*\s*\)/i.test(q)&&!/\bgroup\b/i.test(q))
      return rpTbl(['count'],[[this.docs.length]],'(1 row)');
    if(/\bgroup\s+by\s+source\b/i.test(q)){
      var keys2=this.srcOf(src),gr={};
      keys2.forEach(function(k){gr[k]=this.cntOf(k);},this);
      var hv=q.match(/having\s+count\s*\(\s*\*\s*\)\s*(>=|>)\s*(\d+)/i);
      if(hv)keys2=keys2.filter(function(k){return hv[1]==='>'?gr[k]>+hv[2]:gr[k]>=+hv[2];});
      return rpTbl(['source','count'],keys2.map(function(k){return[k,gr[k]];}),
        '('+keys2.length+' '+rpRowsWord(keys2.length)+')');
    }
    if(/group\s+by/i.test(q)){
      var g={},ord=[],i2;
      for(i2=0;i2<this.docs.length;i2++){
        var k2=this.docs[i2].content;
        if(!g[k2]){g[k2]=0;ord.push(k2);}
        g[k2]++;
      }
      var dup=ord.filter(function(k){return g[k]>1;}).slice(0,this.limAll(q));
      return rpTbl(['content','count'],dup.map(function(k){return[rpLft(k.slice(0,40),40),g[k]];}),
        '('+dup.length+' '+rpRowsWord(dup.length)+')');
    }
    if(/vector_dims/i.test(q))
      return rpTbl(['vector_dims'],[[this.dim||RP_DIM]],'(1 row)');
    if(/\bleft\s*\(\s*content\s*,\s*(\d+)\s*\)/i.test(q)){
      var lw=+q.match(/\bleft\s*\(\s*content\s*,\s*(\d+)\s*\)/i)[1],f1=this.lim(q),sel=this.docs.slice(0,f1);
      var rr=sel.map(function(r){return[r.id,r.title.slice(0,30),r.content.slice(0,lw)];});
      return rpTbl(['id','title','left'],rr,'('+rr.length+' '+rpRowsWord(rr.length)+')');
    }
    if(/\btitle\b/i.test(q)&&/\blimit\b/i.test(q)){
      var f2=this.lim(q);
      var sel2=this.docs.filter(function(r){return !src||r.source===src;}).slice(0,f2);
      return rpTbl(['id','title'],sel2.map(function(r){return[r.id,r.title.slice(0,34)];}),
        '('+sel2.length+' '+rpRowsWord(sel2.length)+')');
    }
    if(/\bsource\b/i.test(q)&&!/\bwhere\b/i.test(q)&&!/\bselect\b[\s\S]*\bsource\b[\s\S]*,\s*count/i.test(q)){
      var u=[],s2={};
      for(i=0;i<this.docs.length;i++)if(!s2[this.docs[i].source]){s2[this.docs[i].source]=1;u.push(this.docs[i].source);}
      return rpTbl(['source'],u.map(function(x){return[x];}),'('+u.length+' '+rpRowsWord(u.length)+')');
    }
    if(/select\s+\*\s+from\s+docs/i.test(q)){
      var f3=this.lim(q),g3=Math.min(f3,this.docs.length);
      return rpTbl(['id','title','source','content','chunk_idx','embedding','created_at'],
        this.docs.slice(0,g3).map(function(r){return[r.id,r.title.slice(0,26),r.source,r.content.slice(0,24),r.chunk_idx,'['+r.v.join(',')+']',r.ts];}),
        '('+g3+' '+rpRowsWord(g3)+')');
    }
    var f4=this.lim(q);
    var sel4=this.docs.filter(function(r){return !src||r.source===src;}).slice(0,f4);
    return rpTbl(['id','title','source','created_at'],
      sel4.map(function(r){return[r.id,r.title.slice(0,30),r.source,r.ts];}),
      '('+sel4.length+' '+rpRowsWord(sel4.length)+')');
  },

  /* ---- python ingest.py ---- */
  py:function(tk){
    var s=tk.slice(1).join(' '),limit=0,lm=s.match(/--limit\s+(\d+)/);
    if(lm)limit=+lm[1];
    if(!/ingest\.py/.test(s))return {t:'python: can\'t open file \''+(tk[1]||'')+'\': [Errno 2] No such file or directory',c:'t-err'};
    if(!/docs|\.\/?\s*$/.test(s))return {t:'usage: ingest.py [--limit N] <каталог>',c:'t-err'};
    if(!this.hasTable){
      out('Traceback (most recent call last):','t-err');
      out('  File "ingest.py", line 74, in <module>','t-err');
      out('    cur.execute("INSERT INTO docs (title, source, content, chunk_idx, embedding) VALUES (%s, %s, %s, %s, %s)")','t-err');
      out('psycopg2.errors.UndefinedTable: relation "docs" does not exist','t-err');
      return null;
    }
    var src=rpRows(),n=limit?Math.min(limit,src.length):src.length,base=this.docs.length,i;
    for(i=0;i<n;i++){var r=src[i];r.id=base+i+1;this.docs.push(r);}
    this.rows=this.docs.length;this.dim=RP_DIM;this.applied=false;
    var warn=base?'WARNING: загружено поверх '+base+' строк — часть чанков продублирована':'INFO: таблица docs пуста, загружаю с нуля';
    later([
      '2026-01-08 10:14:02 INFO  сканирую каталог docs/',
      '2026-01-08 10:14:02 INFO  файлов: 6 · чанков: '+n+' (лимит '+(limit||n)+')',
      '2026-01-08 10:14:03 INFO  эмбеддинги: bge-small-ru-v1.5 (768) → проекция до '+RP_DIM+'d, батч 32',
      '2026-01-08 10:14:05 INFO  эмбеддинги посчитаны: '+n+' за 2.4 c',
      warn,
      '2026-01-08 10:14:06 INFO  записано в app.docs: '+n+' строк · всего в таблице: '+this.rows
    ],300);
    return null;
  },

  /* ---- curl к сервису retrieval ---- */
  api:function(raw){
    var t=raw,pipe='',pm=String(raw).split('|');
    if(pm.length>1){t=pm[0].trim();pipe=pm.slice(1).join('|').trim();}
    var um=t.match(/https?:\/\/[^/\s]+(\/\S*)/),path=um?um[1]:'/search';
    var dm=t.match(/(?:-d|--data(?:-binary|-raw)?)\s+'([^']*)'/);
    var body=null;
    if(dm){try{body=JSON.parse(dm[1]);}catch(e){body=null;}}
    if(dm&&!body)return {t:'curl: (52) Empty reply from server',c:'t-err'};
    if(!dm&&!/-X\s*GET|-G|-I/i.test(t))return {t:'curl: (3) URL using bad/illegal format or missing URL',c:'t-err'};
    var ep=/\/ask/i.test(path)?'ask':(/\/search/i.test(path)?'search':'');
    if(!ep)return {t:'curl: (22) The requested URL returned error: 404 Not Found',c:'t-err'};
    if(this.user!=='dev'&&this.user!=='postgres')
      return {t:'curl: (7) Failed to connect to localhost port 8000 after 0 ms: Connection refused',c:'t-err'};
    var q=body&&body.query?body.query:'';
    if(!this.docs.length){
      var e0=ep==='ask'?{detail:'no documents indexed, run ingest.py first'}:{query:q,hits:[],took_ms:2};
      this.lastJson=e0;
      return rpJson(e0,pipe);
    }
    var qv=rpJit(rpQVec(q),rpH(q||'x')%997);
    var hits=this.search(q,qv),ms=rpMs('api'+q,5,40),i;
    this.log(q,hits.length,ms,hits.length?hits[0].r.title:'—');
    if(ep==='ask'){
      var top=hits[0];
      this.lastJson={
        query:q,
        answer:top?top.r.content.slice(0,160):'Не нашёл релевантных фрагментов в базе.',
        citations:hits.slice(0,3).map(function(h){return{id:h.r.id,source:h.r.source,chunk_idx:h.r.chunk_idx,score:+(1-h.d).toFixed(4)};}),
        model:'qwen2.5:7b-instruct',context_tokens:hits.length*156,took_ms:+rpMs('gen'+q,900,2400)};
      return rpJson(this.lastJson,pipe);
    }
    this.lastJson={query:q,
      hits:hits.map(function(h){return{id:h.r.id,source:h.r.source,chunk_idx:h.r.chunk_idx,score:+(1-h.d).toFixed(4),text:h.r.content.slice(0,90)};}),
      took_ms:+ms};
    return rpJson(this.lastJson,pipe);
  },

  /* ---- главный разбор команды ---- */
  run:function(raw){
    var t=String(raw).trim();
    if(!t)return {t:'bash: пропущена команда',c:'t-dim'};
    if(/^python3?\s/.test(t))return this.py(t.split(/\s+/));
    if(/^curl\s/.test(t))return this.api(t);
    if(/^jq\s/.test(t))return {t:'jq: error (at <stdin>:0): Nothing to parse — сначала отдайте вывод curl',c:'t-err'};
    if(/^psql\b/.test(t)||/^\\/.test(t)){
      var body=t,user='dev';
      if(/^psql\b/.test(t)){
        body=t.replace(/^psql\s+/,'');
        var um2=body.match(/(?:^|\s)-U\s+"?([^"\s]+)"?/);
        if(um2)user=um2[1];
        var cm=body.match(/-c\s+"([^"]*)"/)||body.match(/-c\s+'([^']*)'/);
        if(cm)body=cm[1];
        else{
          body=body.replace(/(^|\s)-(?:d|U|database|username|w|host|p|port|h)\s+\S+/g,'$1').trim();
          if(!body){this.user=user;return RP_V+'\nType "help" for help.\n\nYou are now connected to database "app" as user "'+user+'" on host "localhost" (address "127.0.0.1") at port "5432".\nType \\? for help with psql commands.';}
        }
        if(user!=='dev'&&user!=='postgres'&&user!=='app_reader')
          return {t:'psql: error: FATAL:  role "'+user+'" does not exist',c:'t-err'};
        this.user=user;
        if(user==='app_reader'&&/docs/i.test(body))return {t:'ERROR:  permission denied for table docs',c:'t-err'};
      }
      var r=/^\s*\\/.test(body)?this.meta(body):this.sql(body);
      if(typeof r==='string'&&!/^Time:/m.test(r)&&/^(SELECT|EXPLAIN)/i.test(body.trim()))
        r+='\n\nTime: '+rpMs('tt'+body.length,1,9)+' ms';
      return r;
    }
    if(/^(clear|cls)\s*$/i.test(t))return null;
    if(/^(SELECT|CREATE|INSERT|UPDATE|DELETE|EXPLAIN|ANALYZE|DROP|TRUNCATE|ALTER|VACUUM|BEGIN|COMMIT|ROLLBACK|SET|WITH|COPY|GRANT|REVOKE)\b/i.test(t)){
      var q=this.sql(t);
      if(typeof q==='string'&&!/^Time:/m.test(q)&&/^(SELECT|EXPLAIN)/i.test(t))
        q+='\n\nTime: '+rpMs('tt'+t.length,1,9)+' ms';
      return q;
    }
    return {t:'bash: '+t.split(/\s+/)[0]+': command not found',c:'t-err'};
  },

  env:function(){
    var s=this;
    var b1=envBlock('БАЗА app',
      erow('server','PostgreSQL 16.4','var(--tr-ok)')+
      erow('vector',s.hasExt?'0.7.4 установлено':'нет — CREATE EXTENSION vector',s.hasExt?'var(--tr-ok)':'var(--tr-dim)')+
      erow('таблица docs',s.hasTable?'создана':'нет',s.hasTable?'var(--tr-ok)':'var(--tr-dim)')+
      erow('строк',s.hasTable?String(s.docs.length):'—','var(--tr-cyan)')+
      erow('размерность',s.dim?s.dim+'d':'—','var(--tr-accent2)'));
    var b2=envBlock('ИНДЕКС',
      erow('docs_embedding_hnsw',s.hasIndex?'vector_cosine_ops':'нет',s.hasIndex?'var(--tr-ok)':'var(--tr-dim)')+
      erow('планировщик',!s.hasIndex?'seq scan':(s.applied?'index scan':'seq scan — статистики устарели'),
        !s.hasIndex?'var(--tr-dim)':(s.applied?'var(--tr-ok)':'var(--tr-warn)'))+
      erow('последний план',s.plan,s.plan.indexOf('Index')>-1?'var(--tr-ok)':'var(--tr-warn)'));
    var b3=envBlock('ПОСЛЕДНИЕ ПОИСКИ',s.queries.length?s.queries.slice(0,4).map(function(q){
      return erow(q.q.slice(0,24)||'(вектор)',q.n+' hit · '+q.ms+' ms','var(--tr-pink)');}).join(''):
      '<div class="text-xs" style="color:var(--tr-dim)">запросов не было</div>');
    return b1+b2+b3;
  }
};

/* ---------- jq-эмуляция ---------- */
function rpJson(o,pipe){
  if(!pipe)return JSON.stringify(o);
  var jq=pipe.replace(/^jq\s*/,'').trim(),raw=/(^|\s)-r(\s|$)/.test(jq),am=jq.match(/'([^']*)'/);
  var arg=am?am[1]:'',hits=o.hits||[],res=o;
  if(arg){
    if(/length/.test(arg)){res=String(hits.length);raw=true;}
    else{
      var f=arg.match(/^\.([a-z_]+)(?:\[(\]?)\])?(?:\.\s*([a-z_]+))?/i);
      if(f&&f[1]==='hits'){
        res=f[3]?hits.map(function(h){return f[3]==='source'?h.source:(f[3]==='id'?h.id:(f[3]==='score'?h.score:h.text));}):hits;
        if(Array.isArray(res))res=raw?res.join('\n'):res.map(function(x){return JSON.stringify(x);}).join('\n');
      }
      else if(f&&f[1]==='answer'){res=o.answer;raw=true;}
      else if(f&&Object.prototype.hasOwnProperty.call(o,f[1])){
        res=o[f[1]];
        if(Array.isArray(res))res=raw?res.join('\n'):JSON.stringify(res,null,2);
      }
      else return 'jq: error: '+arg+' is not defined';
    }
  }
  if(typeof res==='string')return res;
  if(Array.isArray(res))return raw?res.join('\n'):JSON.stringify(res,null,2);
  return JSON.stringify(res,null,2);
}

/* ---------- модули ---------- */
var RAGP_MODS=[
  {id:1,n:'Подключение',c:'var(--tr-accent)'},
  {id:2,n:'Расширение и таблица',c:'var(--tr-ok)'},
  {id:3,n:'Загрузка данных',c:'var(--tr-cyan)'},
  {id:4,n:'Индекс и поиск',c:'var(--tr-accent2)'},
  {id:5,n:'Диагностика',c:'var(--tr-warn)'}
];

var RAGP_LS=[
  {
    id:1,m:1,t:'Куда подключаемся',
    task:'Подключитесь к базе app и посмотрите параметры соединения: psql -d app -c "\\conninfo"',
    re:/^psql\s+(?:[\w.:=/-]+\s+)*-c\s+(?:"\\conninfo"|'\\conninfo')\s*$/i,
    th:'psql -d &lt;база&gt; -c "&lt;запрос&gt;" выполняет одну команду и выходит — так же, как в скриптах и в CI. Терминал курса — уже открытая сессия psql на базе app, поэтому \\conninfo можно вызвать и напрямую. \\conninfo показывает, к какой базе и под каким пользователем вы реально подключены.',
    h:['Подсказка рядом: база называется app, а \\conninfo — мета-команда psql.',
        'Строка: psql, ключ -d app, затем -c и \\conninfo в кавычках.',
        'psql -d app -c "\\conninfo"'],
    xp:25
  },
  {
    id:2,m:1,t:'Пустая база',
    task:'Посмотрите список таблиц: \\dt',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?\\dt\s*;?"?\s*$/i,
    th:'\\dt — список отношений в схеме public. Пустой ответ «Did not find any relations» — это не ошибка, а состояние: база есть, а под неё ещё никто не создал таблицу.',
    h:['Внутри psql это мета-команда, начинается с обратного слэша.',
        '\\dt — d = relations, t = tables.',
        '\\dt'],
    xp:25
  },
  {
    id:3,m:1,t:'Схемы',
    task:'Проверьте, какие схемы есть в базе: \\dn',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?\\dn\s*;?"?\s*$/i,
    th:'\\dn показывает схемы. По умолчанию у пользователя одна рабочая схема public — таблица индексатора и будет лежать в ней.',
    h:['Мета-команда для схем: d — names.',
        '\\dn',
        '\\dn'],
    xp:20
  },
  {
    id:4,m:2,t:'Расширение pgvector',
    task:'Установите расширение векторного типа: CREATE EXTENSION vector;',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?vector\s*;?"?\s*$/i,
    th:'Типа vector в стандартном PostgreSQL нет — его даёт расширение pgvector. Пока расширение не установлено, CREATE TABLE с vector упадёт с «type "vector" does not exist».',
    h:['Нужен оператор установки расширения, а не CREATE TABLE.',
        'CREATE EXTENSION, имя расширения — vector.',
        'CREATE EXTENSION vector;'],
    xp:35
  },
  {
    id:5,m:2,t:'Проверка расширения',
    task:'Убедитесь, что расширение появилось: \\dx vector',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?\\dx\s+vector\s*;?"?\s*$/i,
    th:'\\dx vector показывает версию установленного расширения и его схему. Если расширения нет, в выводе будет «Did not find any extension named "vector"».',
    h:['Тот же список расширений, что и при установке, но с фильтром по имени.',
        '\\dx и имя расширения.',
        '\\dx vector'],
    xp:25
  },
  {
    id:6,m:2,t:'Таблица чанков',
    task:'Создайте таблицу под чанки: CREATE TABLE docs (id bigserial PRIMARY KEY, title text NOT NULL, source text NOT NULL, content text NOT NULL, chunk_idx int NOT NULL, embedding vector(8) NOT NULL, created_at timestamptz DEFAULT now());',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?docs\s*\((?=[\s\S]*\bid\b)(?=[\s\S]*\btitle\b)(?=[\s\S]*\bsource\b)(?=[\s\S]*\bcontent\b)(?=[\s\S]*\bchunk_idx\b)(?=[\s\S]*\bembedding\s+vector\s*\(\s*8\s*\))(?=[\s\S]*\bcreated_at\b)[\s\S]*\)\s*;?"?\s*$/i,
    th:'source — это метаданные (путь к файлу), по ним потом фильтруют. embedding vector(8) фиксирует размерность в типе: вставить вектор другой длины не даст. created_at нужен, чтобы потом вычистить протухшее.',
    h:['Колонки: id, title, source, content, chunk_idx, embedding vector(8), created_at.',
        'CREATE TABLE docs (…); — тип эмбеддинга именно vector(8), восемь измерений.',
        'CREATE TABLE docs (id bigserial PRIMARY KEY, title text NOT NULL, source text NOT NULL, content text NOT NULL, chunk_idx int NOT NULL, embedding vector(8) NOT NULL, created_at timestamptz DEFAULT now());'],
    xp:50
  },
  {
    id:7,m:2,t:'Структура таблицы',
    task:'Посмотрите, что получилось: \\d docs',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?\\d\s+docs\s*;?"?\s*$/i,
    th:'\\d — это \\d+ и \\dt: типы, nullable, default и индексы в одном выводе. Это первое, что стоит смотреть после CREATE TABLE и после миграции индексатора.',
    h:['Нужна структура конкретной таблицы.',
        '\\d и имя таблицы.',
        '\\d docs'],
    xp:25
  },
  {
    id:8,m:3,t:'Загрузка корпуса',
    task:'Запустите скрипт загрузки: python ingest.py docs/',
    re:/^python3?\s+ingest\.py\s+(?:\.\/)?docs(?:\/)?(?:\s+--limit\s+\d+)?\s*$/i,
    th:'В проде эмбеддинги считает скрипт, а не база. Он читает папку docs/, режет файлы на чанки, считает векторы и делает пачку INSERT. Запуск — руками или из пайплайна, результат проверяется через psql.',
    h:['Это обычный python-скрипт из репозитория, а не команда psql.',
        'python, имя файла, аргумент — каталог с документами.',
        'python ingest.py docs/'],
    xp:45
  },
  {
    id:9,m:3,t:'Сколько строк',
    task:'Посчитайте загруженные чанки: SELECT count(*) FROM docs;',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?SELECT\s+count\s*\(\s*\*\s*\)\s+FROM\s+docs\s*;?"?\s*$/i,
    th:'Первый вопрос после загрузки — сколько строк фактически легло. Ноль означает, что скрипт отработал вхолостую или упал на вставке.',
    h:['Нужен обычный агрегат count(*).',
        'SELECT count(*) FROM docs;',
        'SELECT count(*) FROM docs;'],
    xp:25
  },
  {
    id:10,m:3,t:'Что именно загрузилось',
    task:'Посмотрите первые строки: SELECT id, title, left(content,60) FROM docs LIMIT 5;',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?SELECT\s+id\s*,\s*title\s*,\s*left\s*\(\s*content\s*,\s*60\s*\)\s+FROM\s+docs\s+LIMIT\s+5\s*;?"?\s*$/i,
    th:'left(content,60) обрезает текст — в консоли видно, какие куски попали в базу. Тут же обнаруживаются задвоения: два соседних id с одинаковым chunk_idx.',
    h:['Нужно три колонки и обрезка текста функцией left.',
        'left(content,60) и LIMIT 5.',
        'SELECT id, title, left(content,60) FROM docs LIMIT 5;'],
    xp:35
  },
  {
    id:11,m:3,t:'Размерность вектора',
    task:'Проверьте размерность эмбеддинга: SELECT vector_dims(embedding) FROM docs LIMIT 1;',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?SELECT\s+vector_dims\s*\(\s*embedding\s*\)\s+FROM\s+docs\s+LIMIT\s+1\s*;?"?\s*$/i,
    th:'vector_dims — функция pgvector. Модель на входе даёт 768 измерений, проекция ужимает до 8. Если в базу попал вектор другой длины, поиск упадёт — поэтому размерность проверяют отдельно.',
    h:['Нужна функция именно pgvector, а не длина массива.',
        'Функция называется так же, как тип: vector от слова dimension.',
        'SELECT vector_dims(embedding) FROM docs LIMIT 1;'],
    xp:30
  },
  {
    id:12,m:4,t:'Индекс HNSW',
    task:'Постройте векторный индекс: CREATE INDEX docs_embedding_hnsw ON docs USING hnsw (embedding vector_cosine_ops);',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?CREATE\s+INDEX\s+(?:CONCURRENTLY\s+)?\w+\s+ON\s+docs\s+USING\s+hnsw\s*\(\s*embedding\s+vector_cosine_ops\s*\)\s*;?"?\s*$/i,
    th:'Без индекса pgvector ищет полным перебором: на 180 строках это незаметно, на миллионе запрос умрёт. vector_cosine_ops обязателен — он под оператор <=>.',
    h:['Нужен CREATE INDEX, метод hnsw и операторный класс для косинуса.',
        'USING hnsw, в скобках embedding и vector_cosine_ops.',
        'CREATE INDEX docs_embedding_hnsw ON docs USING hnsw (embedding vector_cosine_ops);'],
    xp:50
  },
  {
    id:13,m:4,t:'Индекс виден в структуре',
    task:'Проверьте, что индекс создался: \\d docs',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?\\d\s+docs\s*;?"?\s*$/i,
    th:'В секции Indexes у \\d docs теперь две строки: первичный ключ и docs_embedding_hnsw. Не увидели её — индекс не создался, а запросы ушли без него.',
    h:['Та же команда, что и в модуле 2, но теперь смотрите секцию Indexes.',
        '\\d docs',
        '\\d docs'],
    xp:25
  },
  {
    id:14,m:4,t:'Поиск ближайших',
    task:'Найдите 5 ближайших чанков: '+RP_SEARCH,
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?SELECT\s+id\s*,\s*title\s*,\s*embedding\s*<=>\s*'[^']*'\s+AS\s+distance\s+FROM\s+docs\s+ORDER\s+BY\s+embedding\s*<=>\s*'[^']*'\s+LIMIT\s+\d+\s*;?"?\s*$/i,
    th:'Оператор &lt;=&gt; возвращает косинусное расстояние: 0 — совпадение, больше 1 — противоположный смысл. Сортировка по нему и есть nearest-neighbour поиск. Вектор запроса вставляется строкой: pgvector сам приведёт литерал к vector.',
    h:['ORDER BY embedding <=> вектор, плюс AS distance в списке колонок.',
        'Вектор запроса — 8 чисел в квадратных скобках, в одинарных кавычках.',
        RP_SEARCH],
    xp:50
  },
  {
    id:15,m:5,t:'Индекс против фильтра',
    task:'Разберитесь с планом: EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM docs WHERE source = \'runbook.md\' ORDER BY embedding <=> \''+RP_Q+'\' LIMIT 5;',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?EXPLAIN\s*\(\s*ANALYZE\s*,\s*BUFFERS\s*\)\s+SELECT\s+[\s\S]*FROM\s+docs[\s\S]*WHERE[\s\S]*source\s*=\s*'[^']*'[\s\S]*;?"?\s*$/i,
    th:'Главная ловушка pgvector. Фильтр по метаданным в WHERE заставляет планировщик читать таблицу целиком: Hnsw-индекс не умеет отдавать строки, отобранные по колонке, которой в нём нет. Строка «Rows Removed by Filter» — это прочитанные и выброшенные впустую строки.',
    h:['Нужен EXPLAIN с ANALYZE и BUFFERS, а в самом запросе — WHERE source = ... перед ORDER BY.',
        'Сначала EXPLAIN (ANALYZE, BUFFERS), потом SELECT из предыдущего задания с добавленным WHERE.',
        'EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM docs WHERE source = \'runbook.md\' ORDER BY embedding <=> \''+RP_Q+'\' LIMIT 5;'],
    xp:50
  },
  {
    id:16,m:5,t:'Поиск задвоений',
    task:'Найдите перегруженные источники: SELECT source, count(*) FROM docs GROUP BY source HAVING count(*) > 3;',
    re:/^(?:psql\s+(?:[\w.:=/-]+\s+)*-c\s+")?SELECT\s+source\s*,\s*count\s*\(\s*\*\s*\)\s+FROM\s+docs\s+GROUP\s+BY\s+source\s+HAVING\s+count\s*\(\s*\*\s*\)\s*>\s*\d+\s*;?"?\s*$/i,
    th:'Файлы любят перезаливать: скрипт запустили три раза — и в базе три копии каждого чанка. Это молча портит выдачу: одинаковый текст занимает все k слотов контекста. GROUP BY source с HAVING показывает, где именно.',
    h:['Нужна агрегация по source с условием по count(*).',
        'GROUP BY source, затем HAVING count(*) > 3.',
        'SELECT source, count(*) FROM docs GROUP BY source HAVING count(*) > 3;'],
    xp:35
  },
  {
    id:17,m:5,t:'Чистка протухшего',
    task:'Удалите старые версии: DELETE FROM docs WHERE source = \'runbook.md\' AND created_at < \'2026-01-01\';',
    re:/^DELETE\s+FROM\s+docs\s+WHERE\s+source\s*=\s*'[^']+'\s+AND\s+created_at\s*<\s*'\d{4}-\d{2}-\d{2}'\s*;?"?\s*$/i,
    th:'Забытый документ живёт в индексе вечно: HNSW не знает про версии. Чистку вешают на cron или на деплой пайплайна — иначе через год в базе лежат документы, которых в репозитории уже нет.',
    h:['DELETE с двумя условиями: по source и по дате.',
        'created_at сравнивается с датой в одинарных кавычках.',
        'DELETE FROM docs WHERE source = \'runbook.md\' AND created_at < \'2026-01-01\';'],
    xp:45
  },
  {
    id:18,m:5,t:'Retrieval через HTTP',
    task:'Спросите сервис поиска: curl -s -X POST http://localhost:8000/search -H \'Content-Type: application/json\' -d \'{"query":"как делать бэкап"}\' | jq',
    re:/^curl\s+(?:-[\w-]+\s+)*(?:(?:GET|POST|PUT|HEAD|PATCH)\s+)*http:\/\/localhost:8000\/search(?:\s+(?:(?:-H|--header)\s+(?:'[^']*'|"[^"]*")|(?:-s|-S|-L|-k|-i|-I|--compressed)))*\s+(?:-d|--data)\s+'\{\s*"query"\s*:\s*"[^"]+"\s*\}\'\s*(?:\|\s*jq(?:\s+(?:-r|-c|-j)(?:\s+'[^']*')?)?)?\s*$/i,
    th:'В проде SQL не набирают руками: retrieval живёт в сервисе на :8000, а psql к нему отношения не имеет. Клиент шлёт JSON методом POST, jq приводит ответ к читаемому виду.',
    h:['Это curl, а не psql: путь /search на порту 8000, тело — JSON с полем query.',
        'Метод POST, заголовок Content-Type, данные в -d, в конце | jq.',
        'curl -s -X POST http://localhost:8000/search -H \'Content-Type: application/json\' -d \'{"query":"как делать бэкап"}\' | jq'],
    xp:40
  },
  {
    id:19,m:5,t:'Ответ с цитатами',
    task:'Получите финальный ответ: curl -s -X POST http://localhost:8000/ask -H \'Content-Type: application/json\' -d \'{"query":"как делать бэкап"}\' | jq -r \'.answer\'',
    re:/^curl\s+(?:-[\w-]+\s+)*(?:(?:GET|POST|PUT|HEAD|PATCH)\s+)*http:\/\/localhost:8000\/ask(?:\s+(?:(?:-H|--header)\s+(?:'[^']*'|"[^"]*")|(?:-s|-S|-L|-k|-i|-I|--compressed)))*\s+(?:-d|--data)\s+'\{\s*"query"\s*:\s*"[^"]+"\s*\}\'\s*(?:\|\s*jq(?:\s+(?:-r|-c|-j)(?:\s+'[^']*')?)?)?\s*$/i,
    th:'Эндпоинт /ask делает всю цепочку: retrieval → сборка контекста → генерация. Ответ приходит с citations — id и source найденных чанков. Их всегда сверяют с источником вручную: нет цитаты — ответ выдуман.',
    h:['Тот же curl, но путь /ask, а jq -r .answer выводит только текст ответа.',
        'Замените /search на /ask и добавьте jq -r .answer.',
        'curl -s -X POST http://localhost:8000/ask -H \'Content-Type: application/json\' -d \'{"query":"как делать бэкап"}\' | jq -r \'.answer\''],
    xp:50
  }
];

COURSES.rag={
  i:'🧠',n:'RAG · PG',c:'var(--tr-accent2)',
  pr:'dev@rag-lab:~$',ti:'psql — app · pgvector',
  note:'Все команды настоящие: psql, python ingest.py, curl, jq. Сама RAG-система в курсе не поднимается — ответы сервиса на :8000 замоканы, формат ответа соответствует FastAPI.',
  mods:RAGP_MODS,ls:RAGP_LS,
  run:function(raw){var r=RAGP.run(raw);renderEnv();return r;},
  reset:function(){RAGP.reset();},
  env:function(){return RAGP.env();}
};

if(!P.rag)P.rag={xp:0,cur:1,done:[]};

if(typeof renderEnv==='function'&&!renderEnv.__rag){
  var ragBaseRenderEnv=renderEnv;
  renderEnv=function(){
    if(typeof course==='string'&&course==='rag'){
      var C=COURSES.rag;
      $('genT').textContent=C.i+' '+C.n+' · СРЕДА';
      $('genC').style.color=C.c;
      $('genC').innerHTML='<span class="dot" style="background:'+C.c+';box-shadow:0 0 8px '+C.c+'"></span>online';
      $('genB').innerHTML=C.env();
      return;
    }
    ragBaseRenderEnv.apply(null,arguments);
  };
  renderEnv.__rag=true;
}