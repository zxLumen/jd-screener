import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLiepinList, parseLinkedinList, parseBossList, parseMaimaiListing } from '../lib/sources.js'

const LIEPIN = `
<div class="job-list-item" >
  <div class="job-detail-box">
    <a href="https://www.liepin.com/a/78978943.shtml" data-jobId="78978943">
      <div class="job-title-box">
        <div class="ellipsis-1" title="AI应用工程师">AI应用工程师</div>
        <div class="job-dq-box"><span class="dq-bracket">【</span><span class="ellipsis-1">北京-海淀区</span><span class="dq-bracket">】</span></div>
      </div>
      <span class="job-salary">25-40k·15薪</span>
      <div class="job-labels-box"><span class="labels-tag">3-5年</span><span class="labels-tag">本科</span></div>
    </a>
    <div class="job-detail-company-box"><span class="company-name ellipsis-1">某 AI 公司</span></div>
  </div>
</div>
<div class="job-list-item" >
  <div class="job-detail-box">
    <a href="https://www.liepin.com/a/78978944.shtml" data-jobId="78978944">
      <div class="job-title-box"><div class="ellipsis-1">Python 后端</div><div class="job-dq-box">【上海】</div></div>
      <span class="job-salary">30-50k</span>
    </a>
    <span class="company-name">某金融公司</span>
  </div>
</div>`

test('猎聘列表解析：标题/城市/薪资/公司/链接', () => {
  const items = parseLiepinList(LIEPIN)
  assert.equal(items.length, 2)
  assert.equal(items[0].source, 'liepin')
  assert.equal(items[0].id, '78978943')
  assert.equal(items[0].title, 'AI应用工程师')
  assert.equal(items[0].city, '北京-海淀区')
  assert.equal(items[0].company, '某 AI 公司')
  assert.equal(items[0].url, 'https://www.liepin.com/a/78978943.shtml')
  assert.match(items[0].text, /25-40k·15薪/)
  assert.equal(items[1].id, '78978944')
})

const LINKEDIN = `
<li>
  <div class="base-card">
    <a href="https://www.linkedin.com/jobs/view/ai-engineer-at-foo-4465379983?position=1">
      <h3 class="base-search-card__title"> AI Engineer </h3>
    </a>
    <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/foo">Foo Inc</a></h4>
    <span class="job-search-card__location">Beijing, Beijing, China</span>
    <time datetime="2026-11-08">2026-11-08</time>
    <div data-entity-urn="urn:li:jobPosting:4465379983"></div>
  </div>
</li>
<li>
  <div class="base-card">
    <h3 class="base-search-card__title">Backend Engineer</h3>
    <h4 class="base-search-card__subtitle">Bar Ltd</h4>
    <span class="job-search-card__location">Shanghai, China</span>
    <div data-entity-urn="urn:li:jobPosting:4465379984"></div>
  </div>
</li>`

test('LinkedIn 列表解析：id/公司/地点/日期', () => {
  const items = parseLinkedinList(LINKEDIN)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, '4465379983')
  assert.equal(items[0].title, 'AI Engineer')
  assert.equal(items[0].company, 'Foo Inc')
  assert.equal(items[0].city, 'Beijing')
  assert.equal(items[0].postedAt, '2026-11-08')
  assert.equal(items[0].url, 'https://www.linkedin.com/jobs/view/ai-engineer-at-foo-4465379983')
  assert.equal(items[1].city, 'Shanghai')
})

const BOSS = {
  code: 0,
  zpData: {
    jobList: [
      {
        encryptJobId: 'abc123',
        securityId: 'sec-1',
        lid: 'lid-1',
        jobName: 'AI 应用工程师',
        salaryDesc: '30-50K·15薪',
        cityName: '北京',
        areaDistrict: '海淀区',
        businessDistrict: '中关村',
        jobExperience: '3-5年',
        jobDegree: '本科',
        jobLabels: ['Python', 'RAG'],
        skills: ['LangChain', 'Milvus'],
        welfareList: ['五险一金'],
        brandName: '某 AI 公司',
        brandIndustry: '人工智能',
      },
    ],
  },
}

test('BOSS 列表解析：字段与链接', () => {
  const items = parseBossList(BOSS)
  assert.equal(items.length, 1)
  const j = items[0]
  assert.equal(j.source, 'boss')
  assert.equal(j.id, 'abc123')
  assert.equal(j.title, 'AI 应用工程师')
  assert.equal(j.company, '某 AI 公司')
  assert.equal(j.city, '北京')
  assert.equal(j.salaryRaw, '30-50K·15薪')
  assert.match(j.url, /job_detail\/abc123\.html/)
  assert.match(j.text, /LangChain/)
})

const NEXT = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      listing: {
        total: 2,
        page: 1,
        pageSize: 50,
        items: [
          {
            id: 'maimai:job:1',
            title: '大模型应用工程师',
            detailUrl: 'https://maimai.cn/n/job/geo/1',
            companyName: '某公司',
            city: '北京',
            salaryText: '30k-50k·15薪',
            experienceText: '3-5年',
            educationText: '本科及以上',
            tags: ['RAG', 'Agent'],
          },
          {
            id: 'maimai:job:2',
            title: '销售总监',
            detailUrl: 'https://maimai.cn/n/job/geo/2',
            companyName: '某公司',
            city: '上海',
            salaryText: '20k-40k',
            tags: [],
          },
        ],
      },
    },
  },
})}</script>`

test('脉脉公开岗位页解析 __NEXT_DATA__', () => {
  const listing = parseMaimaiListing(NEXT)
  assert.equal(listing.total, 2)
  assert.equal(listing.items.length, 2)
  assert.equal(listing.items[0].title, '大模型应用工程师')
  assert.equal(listing.items[0].salaryText, '30k-50k·15薪')
})
