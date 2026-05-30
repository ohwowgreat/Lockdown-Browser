import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Landing from './pages/Landing'
import TeacherDashboard from './pages/TeacherDashboard'
import TeacherExamBuilder from './pages/TeacherExamBuilder'
import TeacherMonitor from './pages/TeacherMonitor'
import StudentJoin from './pages/StudentJoin'
import StudentExam from './pages/StudentExam'
import StudentDone from './pages/StudentDone'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/teacher" element={<TeacherDashboard />} />
      <Route path="/teacher/exam/new" element={<TeacherExamBuilder />} />
      <Route path="/teacher/exam/:id/edit" element={<TeacherExamBuilder />} />
      <Route path="/teacher/exam/:id/monitor" element={<TeacherMonitor />} />
      <Route path="/student" element={<StudentJoin />} />
      <Route path="/student/exam" element={<StudentExam />} />
      <Route path="/student/done" element={<StudentDone />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}
