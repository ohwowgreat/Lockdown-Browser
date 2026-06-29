import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Landing from './pages/Landing'
import TeacherLogin from './pages/TeacherLogin'
import TeacherDashboard from './pages/TeacherDashboard'
import TeacherExamBuilder from './pages/TeacherExamBuilder'
import TeacherMonitor from './pages/TeacherMonitor'
import AdminDashboard from './pages/AdminDashboard'
import StudentJoin from './pages/StudentJoin'
import StudentExam from './pages/StudentExam'
import StudentDone from './pages/StudentDone'

function ProtectedTeacher({ children }) {
  const { teacher, loading } = useAuth()
  if (loading) return null
  if (!teacher) return <Navigate to="/teacher/login" replace />
  if (teacher.is_admin) return <Navigate to="/admin" replace />
  return children
}

function ProtectedAdmin({ children }) {
  const { teacher, loading } = useAuth()
  if (loading) return null
  if (!teacher) return <Navigate to="/teacher/login" replace />
  if (!teacher.is_admin) return <Navigate to="/teacher" replace />
  return children
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/teacher/login" element={<TeacherLogin />} />
        <Route path="/teacher" element={<ProtectedTeacher><TeacherDashboard /></ProtectedTeacher>} />
        <Route path="/teacher/exam/new" element={<ProtectedTeacher><TeacherExamBuilder /></ProtectedTeacher>} />
        <Route path="/teacher/exam/:id/edit" element={<ProtectedTeacher><TeacherExamBuilder /></ProtectedTeacher>} />
        <Route path="/teacher/exam/:id/preview" element={<ProtectedTeacher><StudentExam /></ProtectedTeacher>} />
        <Route path="/teacher/exam/:id/monitor" element={<ProtectedTeacher><TeacherMonitor /></ProtectedTeacher>} />
        <Route path="/admin" element={<ProtectedAdmin><AdminDashboard /></ProtectedAdmin>} />
        <Route path="/student" element={<StudentJoin />} />
        <Route path="/student/exam" element={<StudentExam />} />
        <Route path="/student/done" element={<StudentDone />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </AuthProvider>
  )
}
