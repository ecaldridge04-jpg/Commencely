import test from 'node:test';
import assert from 'node:assert/strict';
import { entryBoards, loadEntryBoard, normalizeStructuredPosting, structuredPostings, getroLocation } from './entry-employer-feeds.mjs';
import { employerResults } from './employer-jobs.mjs';

const posting = overrides => ({'@type':'JobPosting', title:'Accounting Assistant', description:'No experience required.',
  jobLocation:{address:{addressLocality:'Rogers',addressRegion:'AR'}}, ...overrides});
const markup = job => `<script type="application/ld+json">${JSON.stringify(job)}</script>`;
const response = value => new Response(typeof value === 'string' ? value : JSON.stringify(value));
async function withFetch(run, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = run;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('structured job data supports graphs without executing scripts or accepting expired and foreign roles', () => {
  assert.equal(structuredPostings(markup({'@graph':[posting()]})).length, 1);
  assert.deepEqual(structuredPostings('<script type="application/ld+json">broken</script>'), []);
  assert.ok(normalizeStructuredPosting(posting(), 'https://example.com/job'));
  assert.equal(normalizeStructuredPosting(posting({validThrough:'2000-01-01'}), 'https://example.com/job'), null);
  assert.ok(normalizeStructuredPosting(posting({validThrough:'2031-10-01 00:00:00T23:59'}), 'https://example.com/job'));
  assert.equal(normalizeStructuredPosting(posting({jobLocation:{address:{addressLocality:'Rogers',addressRegion:'MN'}}}), 'https://example.com/job'), null);
  assert.equal(normalizeStructuredPosting(posting(), 'javascript:alert(1)'), null);
});

test('ApplicantPro discovers current bank jobs and ignores off-site sitemap links and closed jobs', async () => {
  const board = entryBoards.find(item => item.board === 'firstwestern');
  await withFetch(async url => {
    const path = new URL(url).pathname;
    if (path === '/sitemap.xml') return response(`<urlset><url><loc>${board.origin}/jobs/1.html</loc></url><url><loc>${board.origin}/jobs/2.html</loc></url><url><loc>https://evil.example/jobs/3.html</loc></url></urlset>`);
    if (path === '/jobs/1.html') return response(markup(posting()));
    if (path === '/jobs/2.html') return response(markup(posting({validThrough:'2000-01-01'})));
    throw new Error('Unexpected request');
  }, async () => {
    const result = await loadEntryBoard(board);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.partial, false);
  });
});

test('TQL discovers listings, keeps local roles, and excludes required relocation', async () => {
  const board = entryBoards.find(item => item.board === 'tql');
  await withFetch(async url => {
    const path = new URL(url).pathname;
    if (path.includes('SearchJobs')) return response(`<a href="${board.origin}/en_US/TQLexternalcareers/JobDetail/local/1">Local</a><a href="${board.origin}/en_US/TQLexternalcareers/JobDetail/move/2">Move</a>`);
    return response(markup(posting({title:path.endsWith('/1') ? 'Entry Level Recruiter' : 'Sales Representative - Relocation Provided'})));
  }, async () => assert.equal((await loadEntryBoard(board)).jobs.length, 1));
});

test('First Security only follows the NWA section and reports unavailable descriptions as partial', async () => {
  const board = entryBoards.find(item => item.board === 'firstsecurity');
  const requests = [];
  await withFetch(async url => {
    requests.push(url);
    if (url.includes('join-us')) return response(`<h4>Northwest Arkansas Openings</h4><a href="https://www.appone.com/MainInfoReq.asp?R_ID=1">A</a><a href="https://www.appone.com/MainInfoReq.asp?R_ID=2">B</a><h4>Mountain Home Openings</h4><a href="https://www.appone.com/MainInfoReq.asp?R_ID=3">C</a>`);
    if (url.endsWith('2')) return new Response('', {status:503});
    return response('<meta itemprop="title" content="Retail Banker"><meta name="description" content="No experience required."><meta itemprop="addressLocality" content="Springdale"><meta itemprop="addressRegion" content="AR">');
  }, async () => {
    const result = await loadEntryBoard(board);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.partial, true);
    assert.equal(requests.some(url => url.endsWith('3')), false);
  });
});

test('bank search pagination excludes internal, closed and out-of-state jobs without treating external=false as private', async () => {
  const board = entryBoards.find(item => item.board === 'ozk');
  const job = (slug, values = {}) => ({data:{slug, title:'Client Service Specialist (Teller)', city:'Bentonville', state:'Arkansas',
    description:'1 year of customer service experience required.', internal:false, external:false, applyable:true, searchable:true, ...values}});
  await withFetch(async url => response({totalCount:4,jobs:new URL(url).searchParams.get('page') === '1' ?
    [job('1'),job('2',{internal:true})] : [job('3',{state:'Ohio'}),job('4',{applyable:false})]}), async () => {
    const result = await loadEntryBoard(board);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.partial, false);
    assert.match(result.jobs[0].absolute_url, /\/jobs\/1/);
  });
});

test('regional board requires an active local posting, keeps real employer attribution and discloses republished text', async () => {
  const board = entryBoards.find(item => item.board === 'careersnwa');
  const state = jobs => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState:{jobs}}}})}</script>`;
  const candidate = {id:1,slug:'1-assistant',title:'Accounting Assistant',locations:['Rogers, AR, USA'],organization:{slug:'local-employer'}};
  await withFetch(async url => {
    if (new URL(url).pathname === '/jobs') return response(state({found:[candidate],total:1}));
    return response(state({currentJob:{...candidate,status:'active',visibility:'visible',closedAt:null,deactivatedAt:null,
      locations:[{name:'Rogers, AR, USA'}],organization:{name:'Local Employer'},description:'No experience required.',url:'https://employer.example/jobs/1'}}));
  }, async () => {
    const data = await loadEntryBoard(board);
    assert.equal(data.jobs.length, 1);
    const jobs = employerResults(data,{location:'Fayetteville, Arkansas'},undefined,board);
    assert.equal(jobs[0].company, 'Local Employer');
    assert.match(jobs[0].source, /Getro/);
    assert.match(jobs[0].sourceUrl, /careersnwa/);
    assert.equal(jobs[0].qualifications.zeroExperience,true);
  });
});

test('a failed new feed is not reported as an empty successful search', async () => {
  await withFetch(async () => new Response('',{status:429}), async () => {
    await assert.rejects(loadEntryBoard(entryBoards.find(item => item.board === 'careersnwa')), /unavailable/);
    await assert.rejects(loadEntryBoard(entryBoards.find(item => item.board === 'ozk')), /429/);
  });
});

test('a later bank search failure preserves jobs already fetched and marks coverage partial', async () => {
  const board = entryBoards.find(item => item.board === 'ozk');
  await withFetch(async url => new URL(url).searchParams.get('page') === '1' ?
    response({totalCount:2,jobs:[{data:{slug:'1',title:'Teller',city:'Rogers',state:'AR',description:'No experience required.',applyable:true}}]}) :
    new Response('',{status:429}), async () => {
    const result = await loadEntryBoard(board);
    assert.equal(result.jobs.length,1);
    assert.equal(result.partial,true);
  });
});

test('Advantage imports local business jobs but not demonstrations, foreign jobs or off-site links', async () => {
  const board = entryBoards.find(item => item.board === 'advantage');
  const seen = [];
  await withFetch(async url => {
    seen.push(url);
    if (new URL(url).pathname === '/search/') return response(`<table>
      <tr><td><a href="/job/?req_id=2026-1">Strategy &amp; Execution Analyst</a></td><td>US-AR-Rogers</td></tr>
      <tr><td><a href="/job/?req_id=2026-2">Part Time Product Demonstrator</a></td><td>US-AR-Rogers</td></tr>
      <tr><td><a href="/job/?req_id=2026-3">Accounting Assistant</a></td><td>US-MN-Rogers</td></tr>
      <tr><td><a href="https://evil.example/job/?req_id=2026-4">Accounting Assistant</a></td><td>US-AR-Rogers</td></tr>
      </table>`);
    return response(markup(posting({title:'Strategy & Execution Analyst'}))+'<main id="main"><p>No experience required.</p></main>');
  }, async () => {
    const data = await loadEntryBoard(board);
    assert.equal(data.jobs.length,1);
    assert.equal(data.partial,false);
    assert.equal(seen.filter(url=>url.includes('/job/')).length,1);
  });
});

test('an explicit regional-board address can supply a missing location, never a company office or street name', () => {
  assert.equal(getroLocation({locations:[],description:'<p><strong>Location: 201 W Walnut St, Rogers, AR.</strong></p>'}), 'Rogers, AR');
  assert.equal(getroLocation({locations:[],description:'<p>Location: 6300 Nall Ave, Mission, KS.</p><p>Our headquarters is Rogers, AR.</p>'}), undefined);
  assert.equal(getroLocation({locations:[],description:'Location: 6201 Rogers Ave, Fort Smith, AR.'}), undefined);
  assert.equal(getroLocation({locations:[{name:'Mission, KS'}],description:'Location: Rogers, AR.'}), undefined);
  assert.equal(getroLocation({locations:[],description:'Our company serves Fayetteville, AR.'}), undefined);
});

test('sparse Arvest listings are checked against their actual full-description location', async () => {
  const board = entryBoards.find(item => item.board === 'careersnwa');
  const state = jobs => `<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{initialState:{jobs}}}})}</script>`;
  const candidates = ['local','outside'].map((name,index)=>({id:index+1,title:'Teller',slug:`${index+1}-${name}`,locations:[],organization:{slug:'arvest-bank-group'}}));
  await withFetch(async url => {
    if(new URL(url).pathname==='/jobs') return response(state({found:candidates,total:2}));
    const location=url.includes('1-local')?'Rogers, AR.':'Mission, KS.';
    return response(state({currentJob:{status:'active',visibility:'visible',title:'Teller',id:url,locations:[],description:`<p>Location: ${location}</p><p>Cash handling experience preferred.</p>`,url:'https://employer.example/job',organization:{name:'Arvest Bank Group'}}}));
  },async()=>{
    const data=await loadEntryBoard(board);
    assert.equal(data.jobs.length,1);
    assert.equal(data.jobs[0].location.name,'Rogers, AR');
  });
});
